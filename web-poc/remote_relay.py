"""Phone remote relay: pairs a phone (web/remote.html, served at /remote) with ONE JellyShell instance and relays input.

Pairing is between instances, not Jellyfin accounts (docs/remote.md):
  - The TV/console (a signed-in JellyShell UI) registers itself as a *host*: a random id + secret it keeps in localStorage.
    Registering needs a valid Jellyfin token, so strangers can't fill the table.
  - Settings -> Phone remote asks for a 6-digit code (10 min, one per host). The phone sends the code and gets a remote
    token bound to that host only. Tokens and host secrets are stored as SHA-256 in $JELLYSHELL_DATA_DIR/remote.json.
  - Input: phone POST /api/remote/send -> per-host queue -> the host long-polls GET /api/remote/poll (held 25 s, answered
    the moment a command arrives). State back (focused text field, now playing): host POST /api/remote/state -> phone
    long-polls GET /api/remote/watch.
  - Player control: `{player:{op,...}}` commands, each op validated and bounded here (_player). The poster for the phone's
    lock screen comes through GET /api/remote/art/<key>: the key is random, minted for the host's CURRENT item only, and the
    image is fetched server-side from JELLYFIN_URL (Jellyfin serves item images anonymously), so the phone needs no Jellyfin
    token and works on the public URL while the TV is on the LAN.
Commands older than STALE_S are dropped at delivery: a TV that reconnects must never replay a burst of old presses.
Both listeners (LAN + public) share this module's state, so a phone on the public URL can drive a TV on the LAN URL.
"""
import hashlib
import json
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request

import access
import config

ACTIONS = {'up', 'down', 'left', 'right', 'select', 'back', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'menu', 'view'}
PRESS = {'down', 'up', 'tap'}
KEYS = {'enter', 'clear'}
HOLD_S = 25          # long-poll hold
ONLINE_S = HOLD_S + 12
STALE_S = 4          # undelivered input older than this is dropped
CODE_TTL = 600
MAX_HOSTS = 64
MAX_REMOTES = 12
MAX_STATE = 32768    # now playing carries track lists + the season's episodes (the TV trims to fit)
ART_MAX = 1024 * 1024  # one cached poster per host (~100 KB at 600 px)
STORE = config.DATA_DIR / 'remote.json'

PAIR = access.Bucket(rate=0.2, burst=8)      # per IP: code guesses
TRAFFIC = access.Bucket(rate=60, burst=300)  # per IP: presses, polls, state

_cv = threading.Condition()
_hosts = {}    # host id -> {'key', 'name', 'created', 'remotes': {token sha: {'name', 'created', 'seen'}}}
_live = {}     # host id -> {'seq', 'cmds': [(seq, t, cmd)], 'polled', 'state', 'v'}
_codes = {}    # code -> (host id, expires)
_fails = []    # failed pair attempts (all IPs), for a global brake
_art = {}      # art key -> {'host', 'src': (item id, tag), 'img': (ctype, bytes) | None}


def _sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _load():
    try:
        data = json.loads(STORE.read_text())
        if isinstance(data, dict) and isinstance(data.get('hosts'), dict):
            _hosts.update(data['hosts'])
    except (OSError, ValueError):
        pass


def _save():
    try:
        STORE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE.with_suffix('.tmp')
        tmp.write_text(json.dumps({'hosts': _hosts}))
        tmp.chmod(0o600)
        tmp.replace(STORE)
    except OSError:
        pass


_load()


class Err(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def _live_of(hid):
    return _live.setdefault(hid, {'seq': 0, 'cmds': [], 'polled': 0, 'state': None, 'v': 1})


def _online(hid):
    return time.time() - _live_of(hid)['polled'] < ONLINE_S


def _remote_list(h):
    return sorted(({'id': k[:10], 'name': r.get('name') or 'Phone', 'created': r.get('created', 0), 'seen': r.get('seen', 0)}
                   for k, r in h['remotes'].items()), key=lambda r: -r['created'])


def _push(hid, cmd):
    lv = _live_of(hid)
    lv['seq'] += 1
    now = time.time()
    lv['cmds'].append((lv['seq'], now, cmd))
    lv['cmds'] = [c for c in lv['cmds'][-200:] if now - c[1] < 30]


def _host(handler):
    hid = handler.headers.get('X-Remote-Host', '')
    key = handler.headers.get('X-Remote-Key', '')
    h = _hosts.get(hid)
    if not h or not key or not secrets.compare_digest(h['key'], _sha(key)):
        raise Err(401, 'unknown host')
    return hid, h


def _remote(handler):
    tok = handler.headers.get('X-Remote-Token', '')
    if tok:
        th = _sha(tok)
        for hid, h in _hosts.items():
            if th in h['remotes']:
                return hid, h, th
    raise Err(401, 'not paired')


def _cmd(c):
    """Validate one phone command; returns the clean dict or None."""
    if not isinstance(c, dict):
        return None
    if c.get('a') in ACTIONS:
        return {'a': c['a'], 't': c.get('t') if c.get('t') in PRESS else 'tap'}
    if isinstance(c.get('text'), str):
        return {'text': c['text'][:500]}
    if c.get('key') in KEYS:
        return {'key': c['key']}
    if c.get('playpause'):
        return {'playpause': True}
    if isinstance(c.get('player'), dict):
        p = _player(c['player'])
        return {'player': p} if p else None
    return None


def _int(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise ValueError
    return max(lo, min(hi, int(v)))


def _num(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise ValueError
    return max(lo, min(hi, float(v)))


def _player(p):
    """Validate one player op from the phone (the TV maps each to the player's own handler). None = dropped."""
    op = p.get('op')
    try:
        if op in ('pp', 'play', 'pause', 'next', 'skipSeg'):
            return {'op': op}
        if op == 'seek':
            return {'op': op, 'ms': _int(p.get('ms'), 0, 24 * 3600_000)}
        if op == 'skip':
            return {'op': op, 'ms': _int(p.get('ms'), -600_000, 600_000)}
        if op in ('audio', 'sub'):
            return {'op': op, 'i': _int(p.get('i'), -1, 9999)}
        if op == 'subOff' and p.get('d') in (-500, 0, 500):
            return {'op': op, 'd': p['d']}
        if op == 'boost':
            return {'op': op, 'db': _int(p.get('db'), 0, 20)}
        if op == 'night' and isinstance(p.get('on'), bool):
            return {'op': op, 'on': p['on']}
        if op == 'pic':
            out = {'op': op}
            if 'b' in p:
                out['b'] = _num(p['b'], 0, 100)
            if 'c' in p:
                out['c'] = _num(p['c'], 0.5, 2)
            return out if len(out) > 1 else None
        if op == 'ep' and isinstance(p.get('id'), str) and re.fullmatch(r'[0-9a-fA-F]{32}', p['id']):
            return {'op': op, 'id': p['id']}
    except ValueError:
        pass
    return None


def _art_key(hid, state):
    """Swap the player's art {id, tag} for a capability URL; same image = same key (the phone doesn't refetch on every tick)."""
    pl = state.get('player') if isinstance(state, dict) else None
    a = pl.pop('art', None) if isinstance(pl, dict) else None
    src = None
    if isinstance(a, dict) and isinstance(a.get('id'), str) and re.fullmatch(r'[0-9a-fA-F]{32}', a['id']):
        tag = a.get('tag') if isinstance(a.get('tag'), str) and re.fullmatch(r'[0-9a-zA-Z]{1,64}', a.get('tag') or '') else ''
        src = (a['id'], tag)
    old = [k for k, v in _art.items() if v['host'] == hid]
    for k in old:
        if src and _art[k]['src'] == src:
            pl['art'] = 'api/remote/art/' + k
            return
        _art.pop(k)
    if src:
        k = secrets.token_urlsafe(18)
        _art[k] = {'host': hid, 'src': src, 'img': None}
        pl['art'] = 'api/remote/art/' + k


def _serve_art(handler, key):
    with _cv:
        a = _art.get(key)
        src, img = (a['src'], a['img']) if a else (None, None)
    if not src:
        raise Err(404, 'not found')
    if not img:
        q = urllib.parse.urlencode({'maxWidth': 600, 'quality': 80, **({'tag': src[1]} if src[1] else {})})
        req = urllib.request.Request(f"{config.JELLYFIN_URL}/Items/{src[0]}/Images/Primary?{q}", headers={'Accept': 'image/*'})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                ctype = r.headers.get('Content-Type', '')
                body = r.read(ART_MAX + 1)
        except OSError:
            raise Err(502, 'image unavailable') from None
        if not ctype.startswith('image/') or len(body) > ART_MAX:
            raise Err(502, 'image unavailable')
        img = (ctype.split(';')[0], body)
        with _cv:
            if key in _art:
                _art[key]['img'] = img
    try:
        handler.send_response(200)
        handler.send_header('Content-Type', img[0])
        handler.send_header('Cache-Control', 'private, max-age=86400')
        handler.send_header('Content-Length', str(len(img[1])))
        handler.end_headers()
        handler.wfile.write(img[1])
    except OSError:
        pass


def _body(handler, cap=MAX_STATE * 4):
    n = int(handler.headers.get('Content-Length', 0) or 0)
    if n > cap:
        raise Err(413, 'body too large')
    data = json.loads(handler.rfile.read(n) or b'null')
    if not isinstance(data, dict):
        raise Err(400, 'bad body')
    return data


def _name(v, default):
    v = re.sub(r'[\x00-\x1f<>]', '', str(v or '')).strip()[:40]
    return v or default


def _route(handler, method, path, ip):
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
    now = time.time()

    # ---------------- host (the TV) ----------------
    if path == '/api/remote/host' and method == 'POST':
        tok = (handler.headers.get('X-Jellyfin-Token', ''), handler.headers.get('X-Jellyfin-User', ''))
        try:
            access.jf_policy(*tok)
        except Exception:
            raise Err(401, 'sign in first') from None
        b = _body(handler)
        hid, key = str(b.get('id', '')), str(b.get('key', ''))
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', hid) or len(key) < 16:
            raise Err(400, 'bad host id')
        with _cv:
            h = _hosts.get(hid)
            if h and not secrets.compare_digest(h['key'], _sha(key)):
                raise Err(403, 'host id taken')
            if not h:
                if len(_hosts) >= MAX_HOSTS:  # evict the oldest host nobody paired with
                    idle = sorted((x for x in _hosts.items() if not x[1]['remotes']), key=lambda x: x[1]['created'])
                    if not idle:
                        raise Err(507, 'too many hosts')
                    _hosts.pop(idle[0][0])
                    for k in [k for k, v in _art.items() if v['host'] == idle[0][0]]:
                        _art.pop(k)
                h = _hosts[hid] = {'key': _sha(key), 'name': '', 'created': now, 'remotes': {}}
            name = _name(b.get('name'), 'TV')
            if h['name'] != name or not h.get('saved'):
                h['name'], h['saved'] = name, True
                _save()
            return 200, {'remotes': _remote_list(h)}

    if path == '/api/remote/code' and method == 'POST':
        with _cv:
            hid, _ = _host(handler)
            for c, (owner, exp) in list(_codes.items()):
                if owner == hid or exp < now:
                    _codes.pop(c)
            code = f'{secrets.randbelow(10 ** 6):06d}'
            while code in _codes:
                code = f'{secrets.randbelow(10 ** 6):06d}'
            _codes[code] = (hid, now + CODE_TTL)
            return 200, {'code': code, 'ttlMs': CODE_TTL * 1000}

    if path == '/api/remote/poll' and method == 'GET':
        try:
            since = int((q.get('since') or ['-1'])[0])
        except ValueError:
            since = -1
        with _cv:
            hid, h = _host(handler)
            lv = _live_of(hid)
            was_online = _online(hid)
            lv['polled'] = now
            if since > lv['seq']:
                since = -1  # relay restarted (seq reset): resync without waiting
            if not was_online:
                _cv.notify_all()  # watching phones: the TV is back
            deadline = now + HOLD_S
            while since >= 0 and lv['seq'] <= since and time.time() < deadline:
                _cv.wait(deadline - time.time())
                if hid not in _hosts:
                    raise Err(401, 'unknown host')
            lv['polled'] = time.time()
            # A release is never dropped: its press may already have been delivered (a stuck hold is worse than a late stop).
            fresh = [dict(c, seq=s) for s, t, c in lv['cmds']
                     if s > since and (time.time() - t < STALE_S or c.get('t') == 'up')] if since >= 0 else []
            return 200, {'seq': lv['seq'], 'cmds': fresh, 'remotes': len(h['remotes'])}

    if path == '/api/remote/state' and method == 'POST':
        b = _body(handler, MAX_STATE)
        with _cv:
            hid, _ = _host(handler)
            lv = _live_of(hid)
            _art_key(hid, b)
            lv['state'], lv['v'] = b, lv['v'] + 1
            _cv.notify_all()
            return 200, {'ok': True}

    if path == '/api/remote/remotes' and method == 'GET':
        with _cv:
            _, h = _host(handler)
            return 200, {'remotes': _remote_list(h)}

    if path.startswith('/api/remote/remotes/') and method == 'DELETE':
        rid = path.rsplit('/', 1)[-1]
        with _cv:
            _, h = _host(handler)
            for k in [k for k in h['remotes'] if rid == 'all' or k[:10] == rid]:
                h['remotes'].pop(k)
            _save()
            _cv.notify_all()  # their watch loops learn they're unpaired
            return 200, {'remotes': _remote_list(h)}

    # ---------------- remote (the phone) ----------------
    if path == '/api/remote/pair' and method == 'POST':
        if not PAIR.allow(ip):
            raise Err(429, 'too many attempts, wait a minute')
        b = _body(handler)
        code = re.sub(r'\D', '', str(b.get('code', '')))
        with _cv:
            _fails[:] = [t for t in _fails if now - t < 600]
            if len(_fails) > 60:
                raise Err(429, 'pairing paused, try again in a few minutes')
            hid, exp = _codes.get(code, (None, 0))
            if not hid or exp < now or hid not in _hosts:
                _fails.append(now)
                raise Err(404, 'That code is wrong or expired. Check the TV.')
            _codes.pop(code)
            h = _hosts[hid]
            if len(h['remotes']) >= MAX_REMOTES:  # drop the least recently used phone
                h['remotes'].pop(min(h['remotes'], key=lambda k: h['remotes'][k].get('seen', 0)))
            tok = secrets.token_urlsafe(24)
            name = _name(b.get('name'), 'Phone')
            h['remotes'][_sha(tok)] = {'name': name, 'created': now, 'seen': now}
            _save()
            _push(hid, {'sys': 'paired', 'name': name})
            _cv.notify_all()
            return 200, {'token': tok, 'host': {'id': hid, 'name': h['name']}}

    if path == '/api/remote/send' and method == 'POST':
        b = _body(handler)
        cmds = [c for c in map(_cmd, (b.get('cmds') or [])[:40]) if c]
        with _cv:
            hid, h, th = _remote(handler)
            for c in cmds:
                _push(hid, c)
            h['remotes'][th]['seen'] = now
            if cmds:
                _cv.notify_all()
            return 200, {'online': _online(hid)}

    if path == '/api/remote/watch' and method == 'GET':
        try:
            v = int((q.get('v') or ['0'])[0])
        except ValueError:
            v = 0
        with _cv:
            hid, h, th = _remote(handler)
            lv = _live_of(hid)
            online = _online(hid)
            deadline = now + HOLD_S
            while lv['v'] == v and _online(hid) == online and time.time() < deadline:
                _cv.wait(min(5, deadline - time.time()))  # wake now and then: online flips without a notify
                if th not in h['remotes'] or hid not in _hosts:
                    raise Err(401, 'not paired')
            return 200, {'v': lv['v'], 'online': _online(hid), 'name': h['name'], 'state': lv['state'] if _online(hid) else None}

    if path == '/api/remote/self' and method == 'DELETE':
        with _cv:
            hid, h, th = _remote(handler)
            h['remotes'].pop(th, None)
            _save()
            _push(hid, {'sys': 'unpaired'})
            _cv.notify_all()
            return 200, {'ok': True}

    raise Err(404, 'not found')


def handle(handler, method):
    path = urllib.parse.unquote(handler.path.split('?', 1)[0])
    if not path.startswith('/api/remote/'):
        return False
    ip = handler._ip() if hasattr(handler, '_ip') else handler.client_address[0]
    try:
        if not config.REMOTE:
            raise Err(404, 'phone remote is off')
        if not TRAFFIC.allow(ip):
            raise Err(429, 'slow down')
        if method == 'GET' and path.startswith('/api/remote/art/'):  # lock-screen poster (key = capability, see _art_key)
            return _serve_art(handler, path.rsplit('/', 1)[-1]) or True
        code, out = _route(handler, method, path, ip)
    except Err as e:
        code, out = e.code, {'error': str(e)}
    except (ValueError, TypeError):
        code, out = 400, {'error': 'bad request'}
    data = json.dumps(out).encode()
    try:
        handler.send_response(code)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
    except OSError:
        pass  # the phone/TV went away during a long poll
    return True
