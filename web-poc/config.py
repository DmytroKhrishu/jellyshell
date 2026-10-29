"""Page-server configuration: environment variables, optionally seeded from a `.env` file at the repo root.

Every setting is documented in docs/configuration.md and .env.example. `.env` never overrides a variable that is
already set (systemd Environment=, docker env, shell export win), so the same file works with and without Docker.
Each integration is OFF when its URL or key is missing; `configured()` is what the capabilities and the 503s use.
"""
import json
import os
import re
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def load_env(path):
    """Minimal KEY=VALUE parser: `#` comments, optional `export `, optional single/double quotes. No overrides."""
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


def url(name, default=''):
    return env(name, default).rstrip('/')


# Inside the Docker image (JELLYSHELL_DOCKER=1) "this host" defaults mean the Docker host, not the container.
IN_DOCKER = env('JELLYSHELL_DOCKER') == '1'
LOCAL_HOST = 'host.docker.internal' if IN_DOCKER else '127.0.0.1'

# ---------------- listeners + files ----------------
BIND = env('JELLYSHELL_BIND', '0.0.0.0')
PORT = int(env('JELLYSHELL_PORT', '8097'))
# In Docker the container's own network namespace is the boundary: the published host port decides who can reach it.
PUBLIC_BIND = env('JELLYSHELL_PUBLIC_BIND', '0.0.0.0' if IN_DOCKER else '127.0.0.1')
PUBLIC_PORT = int(env('JELLYSHELL_PUBLIC_PORT', '0'))  # 0 = public hardened listener off
_prefix = os.environ.get('JELLYSHELL_PUBLIC_PREFIX', '/jellyshell').strip().rstrip('/')
PUBLIC_PREFIX = ('/' + _prefix.lstrip('/')) if _prefix else ''
DEBUG = env('JELLYSHELL_DEBUG', '0').lower() in ('1', 'true', 'yes', 'on')
REMOTE = env('JELLYSHELL_REMOTE', '1').lower() in ('1', 'true', 'yes', 'on')  # phone remote (/remote + /api/remote/*)
DATA_DIR = Path(env('JELLYSHELL_DATA_DIR', '/data' if IN_DOCKER else str(HERE))).expanduser()
LOG_FILE = Path(env('JELLYSHELL_LOG_FILE', str(DATA_DIR / 'client.log'))).expanduser()
STORE_PRODUCT_ID = env('STORE_PRODUCT_ID')
STORE_PRIVATE = env('STORE_PRIVATE') == '1'  # Private-audience listing: web fallback is apps.microsoft.com/detail/restricted/<id>

# ---------------- Jellyfin ----------------
JELLYFIN_URL = url('JELLYFIN_URL', f'http://{LOCAL_HOST}:8096')
JELLYFIN_PUBLIC_URL = url('JELLYFIN_PUBLIC_URL')


def _jf_key():
    if env('JELLYFIN_API_KEY'):
        return env('JELLYFIN_API_KEY')
    f = env('JELLYFIN_API_KEY_FILE')  # docker secret / a file outside the repo: raw key, or JSON {"key": ...}
    if not f:
        return None
    try:
        txt = Path(f).expanduser().read_text().strip()
    except OSError:
        return None
    if txt.startswith('{'):
        try:
            return json.loads(txt).get('key') or None
        except ValueError:
            return None
    return txt or None


JELLYFIN_API_KEY = _jf_key()

# ---------------- *arr stack (explicit env first, then ARR_CONFIG_DIR) ----------------
ARR_DIR = Path(env('ARR_CONFIG_DIR')).expanduser() if env('ARR_CONFIG_DIR') else None
# Used only when a key was found in ARR_CONFIG_DIR but the URL wasn't set: the apps' default ports on ARR_HOST.
ARR_HOST = env('ARR_HOST', LOCAL_HOST)
_ARR_DEFAULT_URL = {k: f'http://{ARR_HOST}:{p}' for k, p in
                    (('seerr', 5055), ('sonarr', 8989), ('radarr', 7878), ('bazarr', 6767), ('qbittorrent', 8081))}


def _read(rel):
    if not ARR_DIR:
        return None
    try:
        return (ARR_DIR / rel).read_text()
    except OSError:
        return None


def _seerr_key_file():
    try:
        return json.loads(_read('seerr/config/settings.json') or 'null')['main']['apiKey']
    except (TypeError, KeyError, ValueError):
        return None


def _xml_key(app):
    m = re.search(r'<ApiKey>(\w+)</ApiKey>', _read(f'{app}/config/config.xml') or '')
    return m.group(1) if m else None


def _bazarr_key_file():
    txt = _read('bazarr/config/config/config.yaml') or ''
    m = re.search(r'^auth:\s*\n((?:[ \t]+.*\n)+)', txt, re.M)
    k = re.search(r'apikey:\s*[\'"]?(\w+)', m.group(1)) if m else None
    return k.group(1) if k else None


def qb_creds_from_sonarr():
    """qBittorrent username/password from Sonarr's download-client settings (read-only; works on a ro mount too)."""
    if not ARR_DIR:
        return None
    db = ARR_DIR / 'sonarr/config/sonarr.db'
    if not db.is_file():
        return None
    for mode in ('ro', 'ro&immutable=1'):  # immutable: the dir is mounted read-only, so no -shm can be created
        try:
            c = sqlite3.connect(f'file:{db}?mode={mode}', uri=True, timeout=3)
            try:
                row = c.execute("select Settings from DownloadClients where Implementation='QBittorrent' limit 1").fetchone()
            finally:
                c.close()
            if not row:
                return None
            s = json.loads(row[0])
            return s.get('username'), s.get('password')
        except (sqlite3.Error, ValueError):
            continue
    return None


def _service(name, key_env, from_dir):
    key = env(key_env) or (from_dir() if ARR_DIR else None)
    u = url(f'{name.upper()}_URL') or (_ARR_DEFAULT_URL[name] if key and ARR_DIR and not env(key_env) else '')
    return (u, key) if u and key else ('', None)


SEERR_URL, SEERR_API_KEY = _service('seerr', 'SEERR_API_KEY', _seerr_key_file)
SONARR_URL, SONARR_API_KEY = _service('sonarr', 'SONARR_API_KEY', lambda: _xml_key('sonarr'))
RADARR_URL, RADARR_API_KEY = _service('radarr', 'RADARR_API_KEY', lambda: _xml_key('radarr'))
BAZARR_URL, BAZARR_API_KEY = _service('bazarr', 'BAZARR_API_KEY', _bazarr_key_file)
# Strip API suffixes people paste from the apps' own docs; the proxies add them.
SEERR_URL = re.sub(r'/api/v1$', '', SEERR_URL)
SONARR_URL = re.sub(r'/api/v3$', '', SONARR_URL)
RADARR_URL = re.sub(r'/api/v3$', '', RADARR_URL)
BAZARR_URL = re.sub(r'/api$', '', BAZARR_URL)

QB_URL = url('QBITTORRENT_URL') or (_ARR_DEFAULT_URL['qbittorrent'] if ARR_DIR and (SONARR_API_KEY or RADARR_API_KEY) else '')
QB_USER, QB_PASS = env('QBITTORRENT_USERNAME'), env('QBITTORRENT_PASSWORD')


def configured():
    """Which integrations are usable (the per-user capabilities and the 503s are derived from this)."""
    return {
        'seerr': bool(SEERR_URL and SEERR_API_KEY),
        'sonarr': bool(SONARR_URL and SONARR_API_KEY),
        'radarr': bool(RADARR_URL and RADARR_API_KEY),
        'bazarr': bool(BAZARR_URL and BAZARR_API_KEY),
        'qbittorrent': bool(QB_URL),
        'jellyfinApiKey': bool(JELLYFIN_API_KEY),
    }


# ---------------- subtitle files: Bazarr/Jellyfin path prefix -> path this process can read/write ----------------
def _path_map():
    out = []
    for part in re.split(r'[;,]', env('MEDIA_PATH_MAP', '/media=/media')):
        src, sep, dst = part.partition('=')
        if sep and src.strip().startswith('/') and dst.strip():
            out.append((src.strip().rstrip('/'), Path(dst.strip()).expanduser()))
    return sorted(out, key=lambda x: -len(x[0]))  # longest prefix first


MEDIA_PATH_MAP = _path_map()


def server_timezone():
    """IANA zone of the household clock: JELLYSHELL_TZ, TZ, /etc/timezone, the /etc/localtime symlink, else UTC."""
    tz = env('JELLYSHELL_TZ') or env('TZ').lstrip(':')
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


def summary():
    """One startup line (no secrets)."""
    on = [k for k, v in configured().items() if v]
    return f"jellyfin={JELLYFIN_URL} integrations={','.join(on) or 'none'} tz={server_timezone()} data={DATA_DIR}"
