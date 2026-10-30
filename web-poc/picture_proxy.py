"""HDR -> SDR tone-mapping picture controls (Jellyfin encoding config through the page server).

Jellyfin's QSV/VAAPI tone-mapping runs `procamp_vaapi=b=<VppTonemappingBrightness>:c=<VppTonemappingContrast>`
before `tonemap_vaapi`. Those two values are SERVER-WIDE (encoding.xml); there is no per-request parameter, so a
change applies to every new transcode. Writing them is Jellyfin-admin only (LAN and public).

Measured on a DV/HDR10 4K source (mean luma, 0-255): b=0 40, b=16 (Jellyfin default) 56, b=32 77, b=48 102;
c=1.2 adds ~+15 at b=16. Typical SDR content averages ~80-110.

  GET  /api/picture  -> {brightness, contrast, canEdit}
  POST /api/picture  {brightness?, contrast?} -> same shape (admins only)
"""
import json
import threading

import access
from arr_proxy import JF, Upstream, _req, jf_auth
from subs_proxy import KEYS

B_MIN, B_MAX = 0.0, 64.0
C_MIN, C_MAX = 0.8, 1.6
_lock = threading.Lock()


def _jf(path, body=None):
    if not KEYS.get('jf'):
        raise Upstream(503, 'JELLYFIN_API_KEY not configured')
    return _req(JF + path, method='POST' if body is not None else 'GET', body=body, headers=jf_auth(KEYS['jf']))


def _state(can_edit):
    cfg = _jf('/System/Configuration/encoding')
    return {
        'brightness': float(cfg.get('VppTonemappingBrightness', 16)),
        'contrast': float(cfg.get('VppTonemappingContrast', 1)),
        'canEdit': can_edit,
    }


def _set(body):
    if not isinstance(body, dict):
        raise Upstream(400, 'bad body')
    with _lock:
        cfg = _jf('/System/Configuration/encoding')
        if 'brightness' in body:
            cfg['VppTonemappingBrightness'] = round(max(B_MIN, min(B_MAX, float(body['brightness']))), 1)
        if 'contrast' in body:
            cfg['VppTonemappingContrast'] = round(max(C_MIN, min(C_MAX, float(body['contrast']))), 2)
        _jf('/System/Configuration/encoding', body=cfg)


def handle(handler, method):
    if handler.path.split('?', 1)[0] != '/api/picture':
        return False
    token = (handler.headers.get('X-Jellyfin-Token', ''), handler.headers.get('X-Jellyfin-User', ''))
    try:
        if not KEYS.get('jf'):  # the UI hides the HDR picture row/button when this fails
            raise Upstream(503, 'not configured')
        info = access.jf_policy(*token)
        if method == 'GET':
            out = _state(info['admin'])
        elif method == 'POST':
            if not info['admin']:
                raise Upstream(403, 'administrators only')
            n = int(handler.headers.get('Content-Length', 0) or 0)
            if n > 4096:
                raise Upstream(413, 'body too large')
            _set(json.loads(handler.rfile.read(n) or b'null'))
            out = _state(True)
            from subs_proxy import arr_proxy_log
            arr_proxy_log(f'picture: {info["name"]} set brightness={out["brightness"]} contrast={out["contrast"]}')
        else:
            raise Upstream(405, 'not allowed')
        code = 200
    except Upstream as e:
        ours = str(e) == 'not configured'  # our own message; other 5xx stay opaque
        code, out = (e.code if 400 <= e.code < 600 else 502), {'error': str(e) if e.code < 500 or ours else 'upstream error'}
    except (ValueError, TypeError):
        code, out = 400, {'error': 'bad value'}
    data = json.dumps(out).encode()
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)
    return True
