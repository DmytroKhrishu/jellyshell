"""JellyShell page server: serves the built UI (web/dist) at /, proxies the optional integrations, collects client logs.

Configuration is environment variables (or a `.env` at the repo root), see config.py / docs/configuration.md.
  LAN listener     JELLYSHELL_BIND:JELLYSHELL_PORT (default 0.0.0.0:8097): what TVs/consoles on the LAN/VPN load.
  Public listener  JELLYSHELL_PUBLIC_BIND:JELLYSHELL_PUBLIC_PORT (off unless the port is set): hardened, deny-by-default
                   handler for a reverse proxy / Tailscale Funnel / Cloudflare Tunnel that serves it under
                   JELLYSHELL_PUBLIC_PREFIX (default /jellyshell). See docs/public-access.md.
API keys never leave this process.

Debug hooks (JELLYSHELL_DEBUG=1, LAN listener only): remote POST /api/cmd {"key":199} | {"keys":[204,204,195]} |
{"tab":"movies"} ... (queued per client, the page polls GET) and POST /snap?name=X (screenshots from tools/).
"""
import json
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import config  # env / .env (must import first: the proxies read it at import time)
import access  # per-user capabilities + public-listener guards
import arr_proxy  # Seerr / *arr proxy (keys stay server-side)
import subs_proxy  # Bazarr subtitle tools (keys stay server-side)
import picture_proxy  # HDR->SDR tone-mapping brightness/contrast (Jellyfin encoding config)
import remote_relay  # phone remote: pairing + input relay (docs/remote.md)

ROOT = Path(__file__).resolve().parent
APKS = {'/tv.apk': 'jellyshell-tv.apk', '/jellyshell-tv.apk': 'jellyshell-tv.apk',
        '/android.apk': 'jellyshell-android.apk', '/jellyshell-android.apk': 'jellyshell-android.apk'}
DIST = Path(config.env('JELLYSHELL_DIST', str(ROOT.parent / 'web' / 'dist')))
MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
    '.map': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg',
}
BIND, PORT = config.BIND, config.PORT
LOG = config.LOG_FILE
# Debug remote control: one queue per client (?c=xbox default | ?c=browser), consumed one per poll.
CMD = {}


def server_timezone():
    return config.server_timezone()


def scrub(text):
    """Remove the Jellyfin API key (if configured) from client log lines."""
    k = config.JELLYFIN_API_KEY
    return text.replace(k, '<key>') if k else text


def public_config(caps=None):
    """GET /api/config: non-secret server facts for the UI (clock zone; the epoch lets the UI spot a skewed client clock).

    `jellyfinUrl` (only when JELLYFIN_PUBLIC_URL is set) is the Jellyfin address clients should log in to.
    `capabilities` (only with a valid X-Jellyfin-Token) tells the UI which features to show this user.
    """
    out = {'timeZone': server_timezone(), 'serverTimeMs': int(time.time() * 1000)}
    if config.JELLYFIN_PUBLIC_URL:
        out['jellyfinUrl'] = config.JELLYFIN_PUBLIC_URL
    if caps is not None:
        out['capabilities'] = caps
    return out


def privacy_page():
    import html as _html
    page = (ROOT / 'privacy.html').read_text()
    c = _html.escape(config.PRIVACY_CONTACT, quote=True)
    contact = (f'<p>Questions about this policy: <a href="mailto:{c}">{c}</a>.</p>' if c
               else '<p>Questions about this policy: contact the administrator of this server.</p>')
    return page.replace('<!--CONTACT-->', contact).encode()


def _append_log(ip, line):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a') as f:
        f.write(f'{datetime.now().isoformat(timespec="seconds")} {ip} {line}\n')


class H(BaseHTTPRequestHandler):
    public = False  # PublicH flips this; the proxies tighten their rules on it

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _caps(self):
        tok = (self.headers.get('X-Jellyfin-Token', ''), self.headers.get('X-Jellyfin-User', ''))
        return access.capabilities(tok, self.public) if tok[0] else None

    def _client(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        return (qs.get('c') or ['xbox'])[0]

    def _debug(self):
        return config.DEBUG and not self.public

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if (arr_proxy.handle(self, 'GET') or subs_proxy.handle(self, 'GET') or picture_proxy.handle(self, 'GET')
                or remote_relay.handle(self, 'GET')):
            return
        if path in ('/remote', '/remote.html') and config.REMOTE:  # phone remote page (web/remote.html)
            self._static('/remote.html')
        elif path in ('/privacy', '/privacy/', '/privacy.html'):  # privacy policy (static, both listeners)
            self._send(200, privacy_page(), 'text/html; charset=utf-8')
        elif path in ('/install', '/install/') and config.STORE_PRODUCT_ID:  # Xbox Edge -> Microsoft Store listing
            pid = urllib.parse.quote(config.STORE_PRODUCT_ID, safe='')
            web = f"apps.microsoft.com/detail/{'restricted/' if config.STORE_PRIVATE else ''}{pid}"  # private listings 404 without restricted/
            page = (f'<!doctype html><meta name="viewport" content="width=device-width"><title>Install JellyShell</title>'
                    f'<body style="background:#111;color:#eee;font:28px sans-serif;padding:60px">'
                    f'<p><a style="color:#a78bfa" href="ms-windows-store://pdp/?productid={pid}">Open JellyShell in the Microsoft Store</a></p>'
                    f'<p style="font-size:20px;color:#999">Fallback: <a style="color:#999" href="https://{web}">{web}</a></p>')
            self._send(200, page.encode(), 'text/html; charset=utf-8')
        elif path in APKS:  # Android APKs for sideloading (both listeners): TV via Downloader, phones via the browser
            name = APKS[path]
            apk = config.DATA_DIR / 'apk' / name  # copy the build-android CI artifacts here
            if apk.is_file():
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.android.package-archive')
                self.send_header('Content-Disposition', f'attachment; filename="{name}"')
                self.send_header('Cache-Control', 'no-cache')
                body = apk.read_bytes()
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self._send(404, b'', 'text/plain')
        elif path == '/api/cmd':
            # Debug off: answer an empty queue (the UI polls this) but never accept commands (POST is 404).
            q = CMD.setdefault(self._client(), []) if self._debug() else []
            cmd = q.pop(0) if q else None
            self._send(200, json.dumps(cmd).encode(), 'application/json')
        elif path == '/api/config':
            self._send(200, json.dumps(public_config(self._caps())).encode(), 'application/json')
        else:
            self._static(path)

    def _static(self, path):
        # Built JellyShell UI (web/dist). Unknown paths fall back to index.html (SPA).
        rel = urllib.parse.unquote(path).lstrip('/') or 'index.html'
        f = (DIST / rel).resolve()
        if not str(f).startswith(str(DIST.resolve())) or not f.is_file():
            f = DIST / 'index.html'
        if not f.is_file():
            self._send(503, b'web/dist missing: run npm run build in web/', 'text/plain')
            return
        ctype = MIME.get(f.suffix, 'application/octet-stream')
        body = f.read_bytes()
        if f.suffix == '.html':
            body = self._html(body)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        # Hashed assets are immutable; index.html must always revalidate so a rebuild shows up on reload.
        cache = 'public, max-age=31536000, immutable' if '/assets/' in path else 'no-store'
        self.send_header('Cache-Control', cache)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body):
        return body

    def do_DELETE(self):
        if not (arr_proxy.handle(self, 'DELETE') or subs_proxy.handle(self, 'DELETE') or remote_relay.handle(self, 'DELETE')):
            self._send(404, b'', 'text/plain')

    def do_POST(self):
        if (arr_proxy.handle(self, 'POST') or subs_proxy.handle(self, 'POST') or picture_proxy.handle(self, 'POST')
                or remote_relay.handle(self, 'POST')):
            return
        if self.path.startswith('/snap') and self._debug():
            n = int(self.headers.get('Content-Length', 0))
            name = urllib.parse.unquote(self.path.split('name=', 1)[-1]).replace('/', '_').replace(' ', '_').replace('..', '_')
            snaps = config.DATA_DIR / 'snaps'
            snaps.mkdir(parents=True, exist_ok=True)
            (snaps / f'{name}.png').write_bytes(self.rfile.read(n))
            self._send(204, b'', 'text/plain')
        elif self.path.startswith('/api/cmd') and self._debug():
            n = int(self.headers.get('Content-Length', 0))
            cmd = json.loads(self.rfile.read(n) or b'null')
            if cmd is not None:
                q = CMD.setdefault(self._client(), [])
                q.append(cmd)
                del q[:-20]
            self._send(204, b'', 'text/plain')
        elif self.path == '/log':
            n = int(self.headers.get('Content-Length', 0))
            _append_log(self.client_address[0], scrub(self.rfile.read(n).decode(errors='replace')))
            self._send(204, b'', 'text/plain')
        else:
            self._send(404, b'', 'text/plain')

    def log_message(self, *a):
        pass


class PublicH(H):
    """Handler for the internet-facing listener (reverse proxy / Tailscale Funnel / Cloudflare Tunnel ->
    https://<host><JELLYSHELL_PUBLIC_PREFIX> -> JELLYSHELL_PUBLIC_BIND:JELLYSHELL_PUBLIC_PORT).

    Deny by default: only the built UI, /api/config, the token-checked proxies and a capped POST /log.
    Debug remote (/api/cmd) and snaps (/snap) never exist here.
    """
    public = True
    server_version = 'JellyShell'
    sys_version = ''
    PREFIX = config.PUBLIC_PREFIX

    def end_headers(self):
        for k, v in access.SEC_HEADERS.items():
            self.send_header(k, v)
        super().end_headers()

    def _ip(self):
        # The proxy sets X-Forwarded-For; the TCP peer is the proxy. Take the LAST hop (the one the proxy appended)
        # so a client can't pick its own rate-limit bucket by sending a fake header.
        return (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[-1].strip()

    def _gate(self, method):
        """Rate limit + body cap + prefix strip. Returns the normalized path or None (response already sent)."""
        ip = self._ip()
        log_path = self.path.startswith(('/log', self.PREFIX + '/log'))
        # The phone remote has its own per-IP limits (remote_relay.TRAFFIC / PAIR): a D-pad is a burst of small POSTs.
        own_limits = self.path.startswith(('/api/remote/', self.PREFIX + '/api/remote/'))
        if not access.GENERAL.allow(ip) or (method in ('POST', 'DELETE') and not log_path and not own_limits and not access.WRITES.allow(ip)):
            self._send(429, b'{"error":"slow down"}', 'application/json')
            return None
        try:
            n = int(self.headers.get('Content-Length', 0) or 0)
        except ValueError:
            n = -1
        if n < 0 or n > access.MAX_BODY:
            self.close_connection = True
            self._send(413, b'{"error":"body too large"}', 'application/json')
            return None
        # Proxies pass the sub-path through as-is or stripped depending on setup: accept both.
        if self.PREFIX and (self.path == self.PREFIX or self.path.startswith((self.PREFIX + '/', self.PREFIX + '?'))):
            self.path = self.path[len(self.PREFIX):] or '/'
            if not self.path.startswith('/'):
                self.path = '/' + self.path
        path = urllib.parse.unquote(self.path.split('?', 1)[0])
        blocked = path.startswith(('/api/cmd', '/snap')) or path.endswith('.map') or '..' in path \
            or (path == '/log' and method != 'POST')
        if blocked:
            self._send(404, b'', 'text/plain')
            return None
        return path

    def _html(self, body):
        # A proxy that strips the prefix delivers `/jellyshell` and `/jellyshell/` both as `/`.
        # Pin the document base so relative assets and API calls always resolve under the mount.
        return body.replace(b'<head>', b'<head>\n  <base href="' + self.PREFIX.encode() + b'/">', 1)

    def do_GET(self):
        if self._gate('GET') is not None:
            super().do_GET()

    def do_HEAD(self):
        self._send(405, b'', 'text/plain')

    def do_DELETE(self):
        if self._gate('DELETE') is not None:
            super().do_DELETE()

    def do_POST(self):
        path = self._gate('POST')
        if path is None:
            return
        if path == '/log':
            n = int(self.headers.get('Content-Length', 0) or 0)
            data = self.rfile.read(min(n, access.MAX_LOG_BODY))
            if n <= access.MAX_LOG_BODY and access.LOGS.allow(self._ip()):
                line = scrub(data.decode(errors='replace')).replace('\r', ' ')
                _append_log(self._ip(), '\n'.join(f'[public] {ln[:2000]}' for ln in line.split('\n')[:20]))
            self._send(204, b'', 'text/plain')
            return
        if not (arr_proxy.handle(self, 'POST') or subs_proxy.handle(self, 'POST') or picture_proxy.handle(self, 'POST')
                or remote_relay.handle(self, 'POST')):
            self._send(404, b'', 'text/plain')

    def do_PUT(self):
        self._send(405, b'', 'text/plain')

    do_PATCH = do_OPTIONS = do_PUT


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # never print tracebacks with request data into the journal


if __name__ == '__main__':
    import threading
    print('jellyshell: ' + config.summary(), flush=True)
    if config.PUBLIC_PORT:
        pub = Server((config.PUBLIC_BIND, config.PUBLIC_PORT), PublicH)
        threading.Thread(target=pub.serve_forever, daemon=True).start()
        print(f'jellyshell: public listener http://{config.PUBLIC_BIND}:{config.PUBLIC_PORT} '
              f'(serve it under {config.PUBLIC_PREFIX or "/"})', flush=True)
    print(f'jellyshell: serving http://{BIND}:{PORT}' + (' (debug hooks on)' if config.DEBUG else ''), flush=True)
    Server((BIND, PORT), H).serve_forever()
