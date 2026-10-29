"""Dash server configuration: DASH_* / IMMICH_* / NP_* environment variables, optionally seeded from the repo-root `.env`.

Everything is optional; a missing integration makes its endpoint answer 503 {"configured": false, "error": ...} and
GET /api/config reports which tiles have data. See docs/configuration.md.
"""
import json
import os
import re
import socket
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def load_env(path):
    """Minimal KEY=VALUE parser (same rules as web-poc/config.py): comments, `export `, quotes; never overrides."""
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        k, sep, v = line.partition('=')
        k, v = k.strip(), v.strip()
        if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k):
            continue
        if v[:1] in ('"', "'") and v[0] in v[1:]:  # quoted value, then an optional ' # comment'
            v = v[1:v.index(v[0], 1)]
        elif ' #' in v:
            v = v.split(' #', 1)[0].rstrip()
        os.environ.setdefault(k, v)


load_env(os.environ.get('JELLYSHELL_ENV_FILE') or REPO / '.env')


def env(name, default=''):
    v = os.environ.get(name)
    return default if v is None or v.strip() == '' else v.strip()


# Optional legacy JSON file ({lat, lon, place, immich_url, immich_key, push_token}); env vars win.
_LEGACY = {}
if env('DASH_CONFIG_FILE'):
    try:
        _LEGACY = json.loads(Path(env('DASH_CONFIG_FILE')).expanduser().read_text())
    except (OSError, ValueError) as e:
        print(f'dash: DASH_CONFIG_FILE unreadable: {e}', flush=True)


def _opt(name, legacy_key):
    v = env(name)
    if v:
        return v
    lv = _LEGACY.get(legacy_key)
    return str(lv).strip() if lv not in (None, '') else ''


IN_DOCKER = env('JELLYSHELL_DOCKER') == '1'
BIND = env('DASH_BIND', '0.0.0.0')
PORT = int(env('DASH_PORT', '8098'))
DATA_DIR = Path(env('DASH_DATA_DIR', '/data' if IN_DOCKER else str(HERE / 'state'))).expanduser()
LOG_FILE = Path(env('DASH_LOG_FILE', str(DATA_DIR / 'client.log'))).expanduser()


def _float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


LAT, LON = _float(_opt('DASH_LAT', 'lat')), _float(_opt('DASH_LON', 'lon'))
PLACE = _opt('DASH_PLACE', 'place')
IMMICH_URL = _opt('IMMICH_URL', 'immich_url').rstrip('/')
IMMICH_API_KEY = _opt('IMMICH_API_KEY', 'immich_key')
PUSH_TOKEN = _opt('DASH_PUSH_TOKEN', 'push_token')
NP_URL = env('NP_URL', 'http://nowplaying:8102' if IN_DOCKER else 'http://127.0.0.1:8102').rstrip('/')  # compose service name
_TRUE = ('1', 'true', 'yes', 'on')
DEBUG = env('DASH_DEBUG', '0').lower() in _TRUE
# Demo mode: every tab on, with clearly flagged sample data wherever a real source is missing (screenshots, UI work).
DEMO = env('DASH_DEMO', '0').lower() in _TRUE
# Server tab + tile: the host's /proc and the Docker socket. On by default wherever /proc exists; 0 hides them.
SERVER_STATS = env('DASH_SERVER_STATS', '1').lower() in _TRUE and Path('/proc/stat').exists()


def parse_ics_feeds(raw):
    """CALENDAR_ICS_URLS -> [{name, color, url}].

    Entries are separated by newlines or by ';' (a ';' inside a URL stays when no new entry follows it). Each entry is
    `URL`, `Name|URL` or `Name|#hex|URL`; `webcal://` means `https://`. Entries without an http(s)/webcal URL are dropped.
    """
    out = []
    entry_start = r'\s*(?:[^|;\n]*\|){0,2}\s*(?:https?|webcals?)://'
    for part in re.split(r'\n|;(?=' + entry_start + ')', raw or ''):
        bits = [b.strip() for b in part.strip().split('|')]
        if len(bits) > 3:
            bits = [bits[0], bits[1], '|'.join(bits[2:])]
        url = bits[-1]
        name = bits[0] if len(bits) >= 2 else ''
        color = bits[1] if len(bits) == 3 else ''
        url = re.sub(r'^webcals?://', 'https://', url, flags=re.I)
        if not re.match(r'https?://[^/\s]+', url, re.I):
            continue
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}', color):
            color = ''
        out.append({'name': name, 'color': color.upper(), 'url': url})
    return out


ICS_FEEDS = parse_ics_feeds(os.environ.get('CALENDAR_ICS_URLS', ''))
ICS_REFRESH_MIN = max(5, int(_float(env('CALENDAR_ICS_REFRESH', '15')) or 15))


def url_host(url):
    """Only the host of a feed URL (the rest is a secret): for logs and status."""
    m = re.match(r'[a-z]+://([^/?#@]*@)?([^/?#:]+)', url or '', re.I)
    return m.group(2) if m else '?'


def _disks():
    out = []
    for part in env('DASH_DISKS', 'System=/').split(';'):
        label, sep, path = part.partition('=')
        if sep and label.strip() and path.strip():
            out.append((label.strip(), path.strip()))
    return out or [('System', '/')]


DISKS = _disks()


def _net_if():
    if env('DASH_NET_IF'):
        return env('DASH_NET_IF')
    # First interface that isn't loopback / a container or VPN bridge, preferring the one with the most traffic.
    best, best_bytes = None, -1
    try:
        for line in open('/proc/net/dev').readlines()[2:]:
            name, data = line.split(':', 1)
            name = name.strip()
            if name == 'lo' or name.startswith(('docker', 'br-', 'veth', 'virbr', 'tailscale', 'tun', 'wg', 'zt')):
                continue
            f = data.split()
            total = int(f[0]) + int(f[8])
            if total > best_bytes:
                best, best_bytes = name, total
    except (OSError, ValueError, IndexError):
        pass
    return best or 'eth0'


NET_IF = _net_if()


def weather_configured():
    return LAT is not None and LON is not None


def photos_configured():
    return bool(IMMICH_URL and IMMICH_API_KEY)


def nowplaying_configured():
    """The sidecar is in use when its device id (shared .env) or an explicit NP_URL is set."""
    return bool(env('NP_URL') or env('NP_DEVICE_ID'))


def push_configured():
    return bool(PUSH_TOKEN)


def ics_configured():
    return bool(ICS_FEEDS)


def server_timezone():
    """IANA zone of the household clock: DASH_TZ, JELLYSHELL_TZ, TZ, /etc/timezone, /etc/localtime, else UTC."""
    tz = env('DASH_TZ') or env('JELLYSHELL_TZ') or env('TZ').lstrip(':')
    if tz and ('/' in tz or tz == 'UTC'):
        return tz
    try:
        t = Path('/etc/timezone').read_text().strip()
        if t:
            return t
    except OSError:
        pass
    try:
        return os.readlink('/etc/localtime').split('zoneinfo/', 1)[1]
    except (OSError, IndexError):
        return 'UTC'


def hostname():
    return env('DASH_HOSTNAME') or socket.gethostname()


def summary():
    on = [n for n, ok in (('weather', weather_configured()), ('photos', photos_configured()), ('push', push_configured()),
                          ('nowplaying', nowplaying_configured()), ('server', SERVER_STATS), ('demo', DEMO)) if ok]
    if ICS_FEEDS:
        on.append(f"ics({','.join(url_host(f['url']) for f in ICS_FEEDS)})")
    return f"integrations={','.join(on) or 'none'} disks={DISKS} net={NET_IF} tz={server_timezone()} data={DATA_DIR}"
