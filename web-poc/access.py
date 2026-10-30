"""Per-caller permissions + public-listener guards (rate limit, body caps, security headers).

The public listener (see server.py PublicH, JELLYSHELL_PUBLIC_PORT) is what a reverse proxy / Tailscale Funnel /
Cloudflare Tunnel exposes at https://<host><JELLYSHELL_PUBLIC_PREFIX>.
Everything here is deny-by-default for that listener; the LAN listener keeps its debug endpoints (JELLYSHELL_DEBUG=1).
"""
import re
import threading
import time

from arr_proxy import JF, Upstream, _req, jf_auth

# ---------------- who is calling (Jellyfin policy, independent of Seerr) ----------------
_pol = {}  # token|claimed -> (expires, info)
_plock = threading.Lock()


def jf_policy(token, claimed=''):
    """Verify a Jellyfin token; returns {'userId','name','admin','subs'} or raises Upstream(401).

    /Users/Me carries the Policy for real user tokens. An API-key token has no user, so (like arr_proxy.whoami)
    the claimed X-Jellyfin-User id is looked up with it; that only works when the token IS a valid key.
    """
    if not token:
        raise Upstream(401, 'missing X-Jellyfin-Token')
    ck = token + '|' + (claimed or '')
    now = time.time()
    with _plock:
        hit = _pol.get(ck)
        if hit and hit[0] > now:
            return hit[1]
    try:
        me = _req(JF + '/Users/Me', headers=jf_auth(token))
    except Upstream as e:
        if e.code in (401, 403) or not re.fullmatch(r'[0-9a-fA-F-]{32,36}', claimed or ''):
            raise Upstream(401, 'invalid Jellyfin token') from None
        me = _req(f'{JF}/Users/{claimed}', headers=jf_auth(token))
    if not isinstance(me, dict) or 'Id' not in me:
        raise Upstream(401, 'invalid Jellyfin token')
    p = me.get('Policy') or {}
    info = {
        'userId': me['Id'].replace('-', '').lower(),
        'name': me.get('Name'),
        'admin': bool(p.get('IsAdministrator')),
        'subs': bool(p.get('IsAdministrator')),  # same rule as subs_proxy.require_manager
    }
    with _plock:
        if len(_pol) > 500:
            _pol.clear()
        _pol[ck] = (now + 300, info)
    return info


def require_admin(token):
    info = jf_policy(*token)
    if not info['admin']:
        raise Upstream(403, 'administrators only')
    return info


def capabilities(token, public):
    """What the UI should offer this caller. None when there's no valid token (UI keeps its defaults).

    Integration flags follow config.configured(): a service without URL+key is hidden for everyone.
      seerr        Seerr configured (the Requests tab exists at all)
      requests     this caller may file requests (Seerr configured; on the public listener also a linked Seerr account)
      downloads    Downloads + release calendar (Jellyfin admin, Sonarr and/or Radarr configured)
      subtitleTools  Bazarr + JELLYFIN_API_KEY configured, Jellyfin admin
      picture      HDR picture controls (JELLYFIN_API_KEY configured; editing stays admin-only via api/picture canEdit)
    """
    try:
        p = jf_policy(*token)
    except Upstream:
        return None
    import arr_proxy
    import config
    import subs_proxy
    c = config.configured()
    caps = {
        'public': public,
        'seerr': c['seerr'],
        'downloads': p['admin'] and arr_proxy.downloads_configured(),
        'subtitleTools': p['subs'] and subs_proxy.configured(),
        'requests': c['seerr'],
        'picture': c['jellyfinApiKey'],
    }
    if public and c['seerr']:
        # No admin fallback on the internet: a Jellyfin user needs a linked Seerr account to request.
        try:
            caps['requests'] = bool(arr_proxy.whoami(*token).get('seerrUserId'))
        except Upstream:
            caps['requests'] = False
    return caps


# ---------------- public listener guards ----------------
class Bucket:
    """Per-key token bucket. allow(key) -> bool."""

    def __init__(self, rate, burst):
        self.rate, self.burst = rate, burst
        self.state = {}
        self.lock = threading.Lock()

    def allow(self, key, cost=1.0):
        now = time.monotonic()
        with self.lock:
            if len(self.state) > 5000:
                self.state.clear()
            tokens, last = self.state.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            ok = tokens >= cost
            self.state[key] = (tokens - cost if ok else tokens, now)
            return ok


GENERAL = Bucket(rate=15, burst=300)   # page + assets + API
WRITES = Bucket(rate=0.2, burst=10)    # POST/DELETE to proxies (requests, subtitle actions)
LOGS = Bucket(rate=1, burst=30)        # client diagnostics

MAX_BODY = 64 * 1024
MAX_LOG_BODY = 8 * 1024

# The app needs: its own scripts/styles (inline style attributes), same-origin Jellyfin (API, images, HLS),
# TMDB posters (Requests), blob: for hls.js MediaSource and its worker.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://image.tmdb.org; media-src 'self' blob:; "
    "connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; manifest-src 'self'; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)
SEC_HEADERS = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
