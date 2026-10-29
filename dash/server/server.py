"""JellyShell Dash backend — stdlib only.

Serves web/dist, proxies Open-Meteo + Immich (key stays here), samples host + Docker metrics into
ring buffers, reads ICS calendar feeds, and accepts calendar/home snapshots pushed by an agent (e.g. dash/mac-agent).

Configuration: DASH_* / IMMICH_* / NP_* / CALENDAR_* environment variables or the repo-root .env (dashconfig.py,
docs/configuration.md). Every integration is optional: weather needs DASH_LAT/DASH_LON, photos IMMICH_URL +
IMMICH_API_KEY, the calendar CALENDAR_ICS_URLS and/or pushes, pushes DASH_PUSH_TOKEN. Missing ones answer
503 {"configured": false}, and GET /api/config `features` tells the UI which tabs and tiles to show.

Pushed data is never fetched from here: the agent POSTs to /api/push/<kind> with
`Authorization: Bearer <DASH_PUSH_TOKEN>`. DASH_DEMO=1 fills every missing source with clearly flagged sample data.
"""
import http.client
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import dashconfig as C
import ics

ROOT = Path(__file__).resolve().parent
DIST = Path(C.env('DASH_DIST', str(ROOT.parent / 'web' / 'dist')))
STATE = C.DATA_DIR
STATE.mkdir(parents=True, exist_ok=True)
BIND, PORT = C.BIND, C.PORT
MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
    '.map': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg',
}
DISKS = C.DISKS  # DASH_DISKS="Label=/path;Label2=/path2"
NET_IF = C.NET_IF  # DASH_NET_IF, else auto-detected
HIST = 720  # 5 s samples -> 1 h


# ---------------------------------------------------------------- small cache
_cache: dict = {}


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        val = fn()
    except Exception as e:  # noqa: BLE001 — serve stale on upstream failure
        if hit:
            return hit[1]
        raise e
    _cache[key] = (time.time(), val)
    return val


class NotConfigured(Exception):
    """An optional integration isn't set up: the handler answers 503 {"configured": false, "error": ...}."""


def get_json(url, headers=None, data=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {}, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# ---------------------------------------------------------------- weather
def weather():
    if not C.weather_configured():
        if C.DEMO:
            return demo_weather()
        raise NotConfigured('weather not configured (set DASH_LAT and DASH_LON)')
    lat, lon = C.LAT, C.LON
    q = urllib.parse.urlencode({
        'latitude': lat, 'longitude': lon, 'timezone': 'auto', 'forecast_days': 7,
        'current': 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,precipitation',
        'hourly': 'temperature_2m,precipitation_probability,weather_code,is_day',
        'minutely_15': 'precipitation',
        'daily': 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max',
    })
    w = get_json('https://api.open-meteo.com/v1/forecast?' + q)
    try:
        aq = get_json('https://air-quality-api.open-meteo.com/v1/air-quality?' + urllib.parse.urlencode(
            {'latitude': lat, 'longitude': lon, 'current': 'european_aqi,pm2_5', 'timezone': 'auto'}))
        w['air'] = aq.get('current')
    except Exception:  # noqa: BLE001
        w['air'] = None
    w['place'] = C.PLACE or w.get('timezone', '').rsplit('/', 1)[-1].replace('_', ' ')
    return w


# ---------------------------------------------------------------- immich
def immich(path, body=None):
    if not C.photos_configured():
        raise NotConfigured('photos not configured (set IMMICH_URL and IMMICH_API_KEY)')
    data = json.dumps(body).encode() if body is not None else None
    h = {'x-api-key': C.IMMICH_API_KEY, 'accept': 'application/json'}
    if data:
        h['content-type'] = 'application/json'
    return get_json(C.IMMICH_URL + path, h, data)


def slim(a):
    ex = a.get('exifInfo') or {}
    place = ', '.join(x for x in (ex.get('city'), ex.get('country')) if x)
    # localDateTime is the wall time where the photo was shot, but Immich tags it "Z"; send it offset-less so the
    # client shows it as-is whatever zone the WebView thinks it is in.
    taken = a.get('localDateTime') or a.get('fileCreatedAt')
    return {'id': a['id'], 'taken': taken[:19] if taken else None, 'place': place,
            'w': ex.get('exifImageWidth'), 'h': ex.get('exifImageHeight')}


MAX_AGE_YEARS = 5
# CLIP smart-search blocklist: (query, depth). Most junk in this library is real camera photos of things
# (phones, boxes, labels, screens), so EXIF alone can't catch it. Depths were tuned on a labelled sample:
# deep for specific junk concepts, shallow for generic ones that also match real photos further down.
JUNK_QUERIES = [
    ('screenshot of a phone screen', 500), ('screenshot of a computer screen', 500), ('document, receipt, paper with text', 500),
    ('whiteboard or presentation slide', 400), ('meme or text image', 400), ('QR code or barcode', 400), ('blurry photo of a floor', 250),
    ('photo of a phone screen', 400), ('a mobile phone with a cracked screen', 300), ('photo of a smartphone held in a hand', 400),
    ('phone on a table', 200), ('photo of a computer screen or monitor', 250), ('online banking website on a monitor', 500),
    ('printed document or menu with text', 400), ('label with text and specifications', 400), ('receipt', 300),
    ('cardboard box with products', 300), ('product packaging box', 300), ('medicine box', 300), ('packaging', 200),
    ('ID document photo', 200), ('passport photo', 200), ('security camera footage', 200), ('bathroom scale', 30),
    ('blurry accidental photo', 300), ('close-up of an object', 200), ('items on a table', 200), ('clothes', 150),
    ('ceiling', 100), ('feet', 50),
    ('computer monitor on a desk', 450), ('laptop on a table', 200), ('photo of a TV screen', 200), ('water meter', 100),
    ('bicycle pedal', 50), ('very dark underexposed photo', 350), ('dark room at night', 100),
    ('handwritten notes on paper', 400), ('notebook page with drawings', 300), ('math formulas on paper', 300),
    ('store shelf with price tags', 300), ('supermarket shelf with products', 200),
    ('photo of a computer screen with a dialog box', 350), ('ipad on a table', 150), ('tablet computer', 400),
    ('plumbing parts', 120), ('stain on a wall', 10),
]


def _smart(q, depth):
    ids, page = set(), 1
    while len(ids) < depth:
        r = immich('/api/search/smart', {'query': q, 'size': min(250, depth - len(ids)), 'page': page, 'type': 'IMAGE'})
        items = r['assets']['items']
        ids.update(a['id'] for a in items)
        if not items or not r['assets'].get('nextPage'):
            break
        page += 1
    return ids


def build_junk():
    """Asset ids Immich's CLIP search ranks as screenshots/documents/objects/etc. (cached 6 h, built in parallel)."""
    def one(qd):
        try:
            return _smart(*qd)
        except Exception as e:  # noqa: BLE001
            print('junk query failed', qd[0], e, flush=True)
            return set()

    with ThreadPoolExecutor(6) as ex:
        return set().union(*ex.map(one, JUNK_QUERIES))


def junk_ids():
    return cached('junk', 6 * 3600, build_junk)


def asset_exif(aid):
    """Full EXIF for one asset (memories come without it); cached a day."""
    return cached(f'exif:{aid}', 86400, lambda: immich(f'/api/assets/{aid}').get('exifInfo') or {})


def is_photo(a, junk):
    """Real camera photo: camera make in EXIF, photo-ish aspect, decent size, not screenshot-named, not flagged by CLIP."""
    name = (a.get('originalFileName') or '').lower()
    if a['id'] in junk or 'screen' in name or name.endswith(('.png', '.gif', '.webp')):
        return False
    ex = a.get('exifInfo') or {}
    if not ex.get('make'):
        try:
            ex = asset_exif(a['id'])
            a['exifInfo'] = ex
        except Exception:  # noqa: BLE001
            return False
    if not ex.get('make'):
        return False
    w, h = ex.get('exifImageWidth') or 0, ex.get('exifImageHeight') or 0
    if w and h:
        lo, hi = sorted((w, h))
        if lo < 1200 or hi / lo > 2.0:  # phone-screen captures are ~9:19.5; real photos are 3:4 / 9:16
            return False
    return True


def demo_photos():
    """DASH_DEMO without Immich: the cached landscape backdrops stand in for photos (ids `demo-<file>`)."""
    bg = backdrops()
    if not bg:
        raise NotConfigured('demo photos need the backdrop cache (DASH_BACKDROPS > 0); it fills within a few minutes')
    ph = [{'id': 'demo-' + b['file'], 'taken': None, 'place': b['name'], 'w': 2560, 'h': 1440} for b in bg]
    return {'mock': True, 'memories': [{'title': '3 years ago', 'assets': ph[:12]}], 'favorites': ph[12:40], 'random': ph[40:100]}


def photos():
    if not C.photos_configured() and C.DEMO:
        return demo_photos()
    today = datetime.now().strftime('%Y-%m-%d')
    cutoff = (datetime.now() - timedelta(days=365 * MAX_AGE_YEARS)).strftime('%Y-%m-%dT00:00:00Z')
    junk = junk_ids()
    out = {'memories': [], 'favorites': [], 'random': []}
    try:
        for m in immich(f'/api/memories?for={today}'):
            yr = (m.get('data') or {}).get('year', datetime.now().year)
            yrs = datetime.now().year - yr
            if yrs > MAX_AGE_YEARS:
                continue
            assets = [slim(a) for a in m.get('assets', []) if a.get('type') == 'IMAGE' and is_photo(a, junk)]
            if assets:
                out['memories'].append({'title': f'{yrs} year{"s" if yrs != 1 else ""} ago' if yrs else 'Today', 'assets': assets})
    except Exception as e:  # noqa: BLE001
        out['memoriesError'] = str(e)
    base = {'type': 'IMAGE', 'withExif': True, 'takenAfter': cutoff}
    out['favorites'] = [slim(a) for a in immich('/api/search/random', {**base, 'size': 80, 'isFavorite': True}) if is_photo(a, junk)][:40]
    out['random'] = [slim(a) for a in immich('/api/search/random', {**base, 'size': 400}) if is_photo(a, junk)][:60]
    return out


# ---------------------------------------------------------------- landscape backdrops (Wikimedia Commons)
BG_DIR = STATE / 'backdrops'
BG_DIR.mkdir(exist_ok=True)
BG_CATS = ['Featured_pictures_of_landscapes', 'Featured_pictures_of_mountains', 'Quality_images_of_landscapes']
BG_TARGET = int(C.env('DASH_BACKDROPS', '150'))  # featured landscape photos to cache; 0 = off
UA = {'User-Agent': 'jellyshell-dash/0.1 (home dashboard; https://jellyfin.org client)'}


def _commons(params):
    q = urllib.parse.urlencode({**params, 'format': 'json'})
    return get_json('https://commons.wikimedia.org/w/api.php?' + q, UA, timeout=30)


def sync_backdrops():
    """Download up to BG_TARGET wide, high-res featured landscape photos (2560 px) + attribution. Idempotent."""
    meta_p = BG_DIR / 'index.json'
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else []
    have = {m['title'] for m in meta}
    if len(meta) >= BG_TARGET:
        return
    titles = []
    for cat in BG_CATS:
        cont = {}
        while len(titles) < 3000:
            d = _commons({'action': 'query', 'list': 'categorymembers', 'cmtitle': 'Category:' + cat, 'cmtype': 'file', 'cmlimit': 500, **cont})
            titles += [m['title'] for m in d['query']['categorymembers']]
            if 'continue' not in d:
                break
            cont = {'cmcontinue': d['continue']['cmcontinue']}
    import random
    random.shuffle(titles)
    for i in range(0, len(titles), 50):
        if len(meta) >= BG_TARGET:
            break
        batch = [t for t in titles[i:i + 50] if t not in have and t.lower().endswith(('.jpg', '.jpeg'))]
        if not batch:
            continue
        d = _commons({'action': 'query', 'titles': '|'.join(batch), 'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata', 'iiurlwidth': 2560})
        for pg in d['query']['pages'].values():
            ii = (pg.get('imageinfo') or [{}])[0]
            w, h = ii.get('width', 0), ii.get('height', 0)
            if w < 2560 or not h or not (1.45 <= w / h <= 2.1):  # wide & big enough for a 4K-ish TV
                continue
            em = ii.get('extmetadata', {})
            strip = lambda s: re.sub(r'<[^>]+>', '', (s or '')).strip()  # noqa: E731
            fid = re.sub(r'[^A-Za-z0-9]+', '_', pg['title'])[-80:] + '.jpg'
            try:
                req = urllib.request.Request(ii['thumburl'], headers=UA)
                with urllib.request.urlopen(req, timeout=60) as r:
                    (BG_DIR / fid).write_bytes(r.read())
            except Exception as e:  # noqa: BLE001
                print('backdrop dl failed', pg['title'], e, flush=True)
                continue
            desc = strip(em.get('ObjectName', {}).get('value')) or pg['title'][5:].rsplit('.', 1)[0].replace('_', ' ')
            desc = re.sub(r'^\d{4}\s+', '', desc)                        # leading year
            desc = re.sub(r'\s*\([^)]*\)', '', desc)                      # (03), (d.j.b)
            desc = re.sub(r'[\s,.-]+\d{1,2}-\d{1,2}-\d{4}.*$', '', desc)  # trailing dates
            desc = re.sub(r'[\s,]+(?:DD\s*)?\d{1,3}$', '', desc).strip(' ,.-')
            meta.append({'title': pg['title'], 'file': fid, 'name': (desc if len(desc) <= 70 else desc[:70].rsplit(' ', 1)[0].rstrip(' ,.-') + '…'),
                         'artist': strip(em.get('Artist', {}).get('value'))[:60],
                         'license': strip(em.get('LicenseShortName', {}).get('value'))})
            have.add(pg['title'])
            meta_p.write_text(json.dumps(meta))
            time.sleep(0.5)  # be polite to Commons
    print(f'backdrops: {len(meta)} cached', flush=True)


def backdrops():
    p = BG_DIR / 'index.json'
    return json.loads(p.read_text()) if p.exists() else []


if BG_TARGET > 0:
    threading.Thread(target=lambda: (time.sleep(3), sync_backdrops()), daemon=True).start()


def _warm_junk():
    """Keep the CLIP blocklist built in the background (cold build ~30-40 s) so /api/photos never waits on it."""
    if not C.photos_configured():
        return
    while True:
        try:
            ids = build_junk()
            if ids:
                _cache['junk'] = (time.time(), ids)  # swap in atomically; requests keep the old set meanwhile
            print(f'junk blocklist: {len(ids)} assets', flush=True)
        except Exception as e:  # noqa: BLE001
            print('junk warm failed', e, flush=True)
        time.sleep(5 * 3600)


threading.Thread(target=_warm_junk, daemon=True).start()


def immich_image(asset_id, size):
    if asset_id.startswith('demo-') and C.DEMO and not C.photos_configured():
        f = (BG_DIR / asset_id[5:]).resolve()
        if f.parent == BG_DIR.resolve() and f.is_file():
            return f.read_bytes(), 'image/jpeg'
    if not C.photos_configured():
        raise NotConfigured('photos not configured (set IMMICH_URL and IMMICH_API_KEY)')
    size = 'preview' if size not in ('thumbnail', 'preview') else size
    req = urllib.request.Request(f"{C.IMMICH_URL}/api/assets/{urllib.parse.quote(asset_id)}/thumbnail?size={size}",
                                 headers={'x-api-key': C.IMMICH_API_KEY})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(), r.headers.get('content-type', 'image/jpeg')


# ---------------------------------------------------------------- server metrics
class Metrics:
    def __init__(self):
        self.hist = {k: deque(maxlen=HIST) for k in ('t', 'cpu', 'mem', 'temp', 'rx', 'tx', 'load')}
        self.containers = []
        self._prev_cpu = None
        self._prev_net = None
        self._prev_ct = {}
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def _cpu():
        f = list(map(int, open('/proc/stat').readline().split()[1:]))
        idle = f[3] + f[4]
        return sum(f), idle

    @staticmethod
    def _mem():
        m = {}
        for line in open('/proc/meminfo'):
            k, v = line.split(':')
            m[k] = int(v.split()[0]) * 1024
        return m

    @staticmethod
    def _temp():
        try:
            for h in Path('/sys/class/hwmon').iterdir():
                try:
                    if (h / 'name').read_text().strip() in ('coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal'):
                        return int((h / 'temp1_input').read_text()) / 1000
                except (OSError, ValueError):
                    continue
        except OSError:
            pass
        return None

    @staticmethod
    def _net():
        for line in open('/proc/net/dev'):
            if line.strip().startswith(NET_IF + ':'):
                f = line.split(':')[1].split()
                return int(f[0]), int(f[8])
        return 0, 0

    def _docker(self):
        try:
            c = http.client.HTTPConnection('localhost')
            c.sock = socket.socket(socket.AF_UNIX)
            c.sock.connect('/var/run/docker.sock')
            c.request('GET', '/containers/json?all=1')
            data = json.load(c.getresponse())
        except Exception:  # noqa: BLE001
            return []
        now = time.time()
        out = []
        for ct in data:
            cid = ct['Id']
            cg = Path(f'/sys/fs/cgroup/system.slice/docker-{cid}.scope')
            mem = cpu = None
            if cg.exists():
                try:
                    mem = int((cg / 'memory.current').read_text())
                    usage = int(next(l for l in (cg / 'cpu.stat').read_text().splitlines() if l.startswith('usage_usec')).split()[1])
                    prev = self._prev_ct.get(cid)
                    if prev:
                        cpu = max(0.0, (usage - prev[1]) / ((now - prev[0]) * 1e6) * 100)
                    self._prev_ct[cid] = (now, usage)
                except Exception:  # noqa: BLE001
                    pass
            labels = ct.get('Labels') or {}
            out.append({'name': ct['Names'][0].lstrip('/'), 'state': ct['State'], 'status': ct['Status'],
                        'stack': labels.get('com.docker.compose.project'), 'mem': mem, 'cpu': cpu})
        out.sort(key=lambda x: -(x['mem'] or 0))
        return out

    def _loop(self):
        tick = 0
        while True:
            try:
                total, idle = self._cpu()
                cpu = None
                if self._prev_cpu:
                    dt, di = total - self._prev_cpu[0], idle - self._prev_cpu[1]
                    cpu = 100 * (1 - di / dt) if dt else 0
                self._prev_cpu = (total, idle)
                m = self._mem()
                rx, tx = self._net()
                now = time.time()
                rxr = txr = None
                if self._prev_net:
                    dt = now - self._prev_net[0]
                    rxr, txr = (rx - self._prev_net[1]) / dt, (tx - self._prev_net[2]) / dt
                self._prev_net = (now, rx, tx)
                with self.lock:
                    if cpu is not None:
                        h = self.hist
                        h['t'].append(int(now))
                        h['cpu'].append(round(cpu, 1))
                        h['mem'].append(round(100 * (1 - m['MemAvailable'] / m['MemTotal']), 1))
                        h['temp'].append(self._temp())
                        h['rx'].append(round(rxr or 0))
                        h['tx'].append(round(txr or 0))
                        h['load'].append(os.getloadavg()[0])
                    if tick % 3 == 0:  # containers every 15 s
                        self.containers = self._docker()
                tick += 1
            except Exception as e:  # noqa: BLE001
                print('metrics error', e, flush=True)
            time.sleep(5)

    def snapshot(self):
        m = self._mem()
        disks = []
        for label, mp in DISKS:
            try:
                u = shutil.disk_usage(mp)
                disks.append({'label': label, 'mount': mp, 'total': u.total, 'used': u.used, 'free': u.free})
            except OSError:
                disks.append({'label': label, 'mount': mp, 'missing': True})
        with self.lock:
            hist = {k: list(v) for k, v in self.hist.items()}
            cts = list(self.containers)
        up = float(open('/proc/uptime').read().split()[0])
        try:
            psi = open('/proc/pressure/memory').readline().split()[1].split('=')[1]
        except (OSError, IndexError):
            psi = 0  # kernels without PSI
        return {
            'host': C.hostname(), 'uptime': up, 'cores': os.cpu_count(), 'load': os.getloadavg(),
            'mem': {'total': m['MemTotal'], 'available': m['MemAvailable'], 'psi10': float(psi)},
            'disks': disks, 'containers': cts, 'hist': hist, 'netIf': NET_IF,
        }


# ---------------------------------------------------------------- pushed snapshots (any agent; the author's is dash/mac-agent)
def load_push(kind):
    p = STATE / f'{kind}.json'
    if p.exists():
        return json.loads(p.read_text())
    return None


def calendar_label(c):
    """Google primary calendars are named after the account: 'me@gmail.com' -> 'Personal', 'me@acme.com' -> 'Acme'."""
    if '@' in (c or ''):
        dom = c.split('@', 1)[1]
        return 'Personal' if dom in ('gmail.com', 'googlemail.com', 'icloud.com', 'me.com') else dom.split('.')[0].title()
    return c


def household_tz():
    """Zone for all-day events and floating times: DASH_TZ / TZ / host zone, else (UTC default) the weather location's."""
    tz = C.server_timezone()
    if tz in ('UTC', 'Etc/UTC', 'Etc/Universal', 'Universal') and not (C.env('DASH_TZ') or C.env('JELLYSHELL_TZ') or C.env('TZ')):
        hit = _cache.get('weather')
        tz = (hit[1].get('timezone') if hit else None) or tz
    try:
        return ZoneInfo(tz)
    except Exception:  # noqa: BLE001
        return timezone.utc


# ---------------------------------------------------------------- ICS calendar feeds (CALENDAR_ICS_URLS)
ICS_MAX_BYTES = 15 * 1024 * 1024


class IcsFeeds:
    """Polls every feed in the background. Each feed keeps its last good copy, so one broken feed never empties the
    calendar. Feed URLs are secrets (Google's "secret address", iCloud public links): only the host is ever logged."""

    def __init__(self, feeds):
        self.feeds = [dict(f, host=C.url_host(f['url']), cal=None, etag=None, modified=None, ok_at=None, error=None, tried_at=None)
                      for f in feeds]
        self.lock = threading.Lock()
        self.rev = 0
        if self.feeds:
            threading.Thread(target=self._loop, daemon=True).start()

    def _fetch(self, f):
        h = {'User-Agent': UA['User-Agent'], 'Accept': 'text/calendar, */*;q=0.5'}
        if f['etag']:
            h['If-None-Match'] = f['etag']
        if f['modified']:
            h['If-Modified-Since'] = f['modified']
        try:
            with urllib.request.urlopen(urllib.request.Request(f['url'], headers=h), timeout=25) as r:
                body = r.read(ICS_MAX_BYTES + 1)
                if len(body) > ICS_MAX_BYTES:
                    raise ValueError('feed larger than 15 MB')
                etag, modified = r.headers.get('ETag'), r.headers.get('Last-Modified')
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None
            raise ValueError(f'HTTP {e.code}') from None
        except urllib.error.URLError as e:
            raise ValueError(f'unreachable ({type(e.reason).__name__})') from None
        text = body.decode('utf-8', errors='replace')
        if 'BEGIN:VCALENDAR' not in text[:4096].upper():
            raise ValueError('not an iCalendar feed (wrong link, or the calendar is not shared)')
        return ics.parse(text), etag, modified

    def refresh(self):
        changed = False
        for f in self.feeds:
            try:
                got = self._fetch(f)
                with self.lock:
                    f['tried_at'] = time.time()
                    f['ok_at'], f['error'] = time.time(), None
                    if got:
                        f['cal'], f['etag'], f['modified'] = got
                        changed = True
                if got:
                    print(f"ics: {f['host']}: {len(got[0].events)} VEVENTs", flush=True)
            except Exception as e:  # noqa: BLE001 — one feed failing must not stop the others
                msg = str(e).replace(f['url'], f['host'])[:200]
                with self.lock:
                    f['tried_at'], f['error'] = time.time(), msg
                print(f"ics: {f['host']}: {msg} (keeping the last good copy)" if f['cal'] else f"ics: {f['host']}: {msg}", flush=True)
        if changed:
            with self.lock:
                self.rev += 1

    def _loop(self):
        while True:
            self.refresh()
            time.sleep(C.ICS_REFRESH_MIN * 60)

    def status(self):
        with self.lock:
            return [{'name': f['name'] or (calendar_label(f['cal'].name) if f['cal'] else '') or f['host'], 'host': f['host'],
                     'ok': f['cal'] is not None and not f['error'], 'error': f['error'], 'updatedAt': f['ok_at'],
                     'loaded': f['cal'] is not None} for f in self.feeds]

    def events(self):
        """Instances from 8 days back to 9 days ahead (household zone), cached per (feed revision, day)."""
        tz = household_tz()
        today = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        key = (self.rev, today.isoformat(), str(tz))
        hit = _cache.get('ics-expanded')
        if hit and hit[1][0] == key:
            return hit[1][1]
        with self.lock:
            cals = [(f['cal'], f['name'], f['color'], f['host']) for f in self.feeds if f['cal'] is not None]
        out = []
        for cal, name, color, host in cals:
            try:
                out += ics.expand(cal, today - timedelta(days=8), today + timedelta(days=9), tz,
                                  name=name or calendar_label(cal.name), color=color)
            except Exception as e:  # noqa: BLE001
                print(f'ics: {host}: expand failed: {e}', flush=True)
        _cache['ics-expanded'] = (time.time(), (key, out))
        return out


ICS = IcsFeeds(C.ICS_FEEDS)


def _instant(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return s


def calendar_data():
    """GET /api/calendar: pushed events + ICS feed events, identical title+start+calendar deduped."""
    pushed = load_push('calendar') if C.push_configured() or C.DEMO else None
    feeds = ICS.status()
    if pushed is None and not feeds:
        if C.DEMO:
            return mock_calendar()
        raise NotConfigured('calendar not configured (set CALENDAR_ICS_URLS, or push events with DASH_PUSH_TOKEN)')
    events, seen = [], set()
    for e in [*(dict(e, source=e.get('source') or 'push') for e in (pushed or {}).get('events', [])), *ICS.events()]:
        k = (e.get('title'), _instant(e.get('start')), e.get('calendar'))
        if k not in seen:
            seen.add(k)
            events.append(e)
    stamps = [t for t in [(pushed or {}).get('updatedAt'), *(f['updatedAt'] for f in feeds)] if t]
    return {'updatedAt': max(stamps) if stamps else time.time(), 'events': events,
            'sources': {'push': {'updatedAt': pushed.get('updatedAt')} if pushed else None, 'ics': feeds}}


def demo_weather():
    """DASH_DEMO without DASH_LAT/LON: a plausible Open-Meteo-shaped forecast (flagged mock) in the household zone."""
    import math
    tz = household_tz()
    now = datetime.now(tz).replace(tzinfo=None)
    h0 = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=now.hour)
    hours = [h0 + timedelta(hours=i) for i in range(7 * 24)]
    temp = [round(9 + 5 * math.sin((t.hour - 9) / 24 * 2 * math.pi) + (t.day % 3), 1) for t in hours]
    codes = [(0, 1, 2, 3, 61, 3, 2)[(t.day + t.hour // 6) % 7] for t in hours]
    fmt = lambda t: t.strftime('%Y-%m-%dT%H:%M')  # noqa: E731
    days = [h0 + timedelta(days=i) for i in range(7)]
    q0 = now.replace(minute=now.minute // 15 * 15, second=0, microsecond=0)
    i = now.hour
    return {'mock': True, 'timezone': str(tz), 'place': 'Demo City', 'air': {'european_aqi': 24, 'pm2_5': 6.1},
            'current': {'time': fmt(now.replace(second=0, microsecond=0)), 'temperature_2m': temp[i], 'apparent_temperature': temp[i] - 2,
                        'relative_humidity_2m': 64, 'weather_code': codes[i], 'is_day': int(7 <= now.hour < 18), 'wind_speed_10m': 11, 'precipitation': 0},
            'hourly': {'time': [fmt(t) for t in hours], 'temperature_2m': temp, 'weather_code': codes,
                       'precipitation_probability': [60 if c == 61 else 10 for c in codes], 'is_day': [int(7 <= t.hour < 18) for t in hours]},
            'minutely_15': {'time': [fmt(q0 + timedelta(minutes=15 * k)) for k in range(16)], 'precipitation': [0, 0, 0.1, 0.3, 0.2] + [0] * 11},
            'daily': {'time': [d.strftime('%Y-%m-%d') for d in days], 'weather_code': [codes[k * 24 + 13] for k in range(7)],
                      'temperature_2m_max': [max(temp[k * 24:(k + 1) * 24]) for k in range(7)],
                      'temperature_2m_min': [min(temp[k * 24:(k + 1) * 24]) for k in range(7)],
                      'sunrise': [fmt(d.replace(hour=6, minute=58)) for d in days], 'sunset': [fmt(d.replace(hour=16, minute=41)) for d in days],
                      'uv_index_max': [2.1] * 7, 'precipitation_probability_max': [10, 60, 20, 10, 70, 30, 10]}}


def mock_calendar():
    now = datetime.now().replace(second=0, microsecond=0)
    base = now.replace(minute=0) + timedelta(hours=1)

    def ev(title, start, mins, cal, color, url=None, loc=None, all_day=False):
        return {'title': title, 'start': start.isoformat(), 'end': (start + timedelta(minutes=mins)).isoformat(),
                'calendar': cal, 'color': color, 'url': url, 'location': loc, 'allDay': all_day}
    events = [
        ev('Standup', now + timedelta(minutes=4), 15, 'Work', '#1BADF8', 'https://meet.example.com/standup'),
        ev('Design review', base + timedelta(hours=2), 60, 'Work', '#1BADF8', 'https://meet.example.com/review'),
        ev('Gym', base + timedelta(hours=5), 90, 'Home', '#63DA38', loc='Gym'),
        ev('Public holiday', now.replace(hour=0, minute=0), 1440, 'Holidays', '#CC73E1', all_day=True),
        ev('Sprint planning', base + timedelta(days=1, hours=1), 60, 'Work', '#1BADF8', 'https://meet.example.com/planning'),
        ev('Dinner with friends', base + timedelta(days=1, hours=8), 120, 'Family', '#FF2968', loc='Downtown'),
        ev('Dentist', base + timedelta(days=3), 45, 'Home', '#63DA38'),
    ]
    return {'mock': True, 'updatedAt': time.time(), 'events': events}


def mock_home():
    return {'mock': True, 'updatedAt': time.time(), 'home': 'Home',
            'scenes': [{'name': n} for n in ('Good Morning', 'Movie Time', 'Evening', 'Good Night', 'Leave Home')],
            'rooms': [
                {'name': 'Living Room', 'accessories': [
                    {'name': 'Ceiling', 'type': 'light', 'on': True, 'brightness': 70},
                    {'name': 'LED Strip', 'type': 'light', 'on': True, 'brightness': 40},
                    {'name': 'Temperature', 'type': 'sensor', 'value': 22.4, 'unit': '°C'},
                    {'name': 'Humidity', 'type': 'sensor', 'value': 48, 'unit': '%'}]},
                {'name': 'Bedroom', 'accessories': [
                    {'name': 'Bedside', 'type': 'light', 'on': False, 'brightness': 0},
                    {'name': 'Vacuum', 'type': 'switch', 'on': False}]},
                {'name': 'Kitchen', 'accessories': [
                    {'name': 'Pendant', 'type': 'light', 'on': False, 'brightness': 0},
                    {'name': 'Kettle', 'type': 'outlet', 'on': False}]},
            ]}


# ---------------------------------------------------------------- UI settings (Settings tab; shared by every client)
SETTINGS_P = STATE / 'settings.json'
SETTINGS_DEFAULT = {'idleMinutes': 3, 'idleEnabled': True}


def load_settings():
    try:
        return {**SETTINGS_DEFAULT, **json.loads(SETTINGS_P.read_text())}
    except Exception:  # noqa: BLE001
        return dict(SETTINGS_DEFAULT)


def save_settings(patch):
    s = load_settings()
    if 'idleMinutes' in patch:
        s['idleMinutes'] = max(1, min(240, int(patch['idleMinutes'])))
    if 'idleEnabled' in patch:
        s['idleEnabled'] = bool(patch['idleEnabled'])
    SETTINGS_P.write_text(json.dumps(s))
    return s


HOME_QUEUE: deque = deque(maxlen=50)  # commands for the Mac agent
REMOTE_Q: dict = {}  # debug key queues for the page, keyed by ?c= (the console drains 'xbox')


def normalize_home(raw):
    """HomeClaw `list --json` + `scenes --json` -> {home, scenes, rooms:[{name, accessories}]} for the UI."""
    order = {'lightbulb': 0, 'outlet': 1, 'switch': 2, 'fan': 2, 'sensor': 3}
    rooms: dict = {}
    for a in raw.get('accessories', []):
        cat = a.get('category')
        st = a.get('state') or {}
        if cat == 'bridge' or a.get('is_bridge') or 'input_event' in st:  # hubs + stateless buttons
            continue
        item = {'id': a['id'], 'name': a.get('display_name') or a['name'], 'reachable': a.get('reachable', True)}
        if 'power' in st:
            item['on'] = st['power'] == 'true'
            item['type'] = 'light' if cat == 'lightbulb' or a.get('semantic_type') == 'lighting' else 'outlet'
            if st.get('brightness') not in (None, '--'):
                item['brightness'] = int(float(st['brightness']))
        elif 'contact_state' in st:
            item.update(type='sensor', kind='contact', value='Open' if st['contact_state'] != '0' else 'Closed', unit='')
        elif 'current_temperature' in st:
            item.update(type='sensor', value=round(float(st['current_temperature']), 1), unit='°C')
        elif 'current_relative_humidity' in st or 'humidity' in st:
            item.update(type='sensor', value=round(float(st.get('current_relative_humidity') or st['humidity'])), unit='%')
        else:
            continue
        if 'battery_level' in st and st['battery_level'] not in ('--', None):
            item['battery'] = int(float(st['battery_level']))
        # strip a leading room name ("Living Room KAJPLATS…" -> "KAJPLATS…")
        room = a.get('room') or 'Other'
        if item['name'].startswith(room + ' '):
            item['name'] = item['name'][len(room) + 1:]
        rooms.setdefault(room, []).append(item)
    for accs in rooms.values():
        accs.sort(key=lambda x: (order.get(x['type'], 9), x['name']))
        names = [a['name'] for a in accs]
        seen: dict = {}
        for a in accs:
            if names.count(a['name']) > 1:
                seen[a['name']] = seen.get(a['name'], 0) + 1
                a['name'] = f"{a['name']} {seen[a['name']]}"
    scenes = [{'id': s['id'], 'name': s['name']} for s in raw.get('scenes', [])
              if s.get('action_count', 0) > 0 and not re.fullmatch(r'[0-9A-F-]{36}', s['name'])]
    home_name = next((s.get('home_name') for s in raw.get('scenes', []) if s.get('home_name')), 'Home')
    return {'home': home_name, 'scenes': scenes,
            'rooms': [{'name': r, 'accessories': rooms[r]} for r in sorted(rooms, key=lambda r: (r == 'Default Room', r))]}
METRICS = Metrics() if C.SERVER_STATS else None


# ---------------------------------------------------------------- HomePod now playing (pyatv sidecar)
# server/nowplaying.py (optional pyatv sidecar, own venv or the `nowplaying` compose service) listens on NP_URL; we proxy.
NP_URL = C.NP_URL


def nowplaying(mock=''):
    if mock == 'idle':  # dev-only (?mock=idle)
        return {'available': True, 'device': 'HomePod', 'device_state': 'idle', 'mock': True, 'artwork_url': None}
    if mock == '1':  # dev-only (?mock=1): a playing state for layout work when nothing plays on the HomePod
        bg = backdrops()
        t0 = time.time()
        return {'available': True, 'device': 'HomePod', 'device_state': 'playing', 'title': 'Midnight City',
                'artist': 'M83', 'album': "Hurry Up, We're Dreaming", 'genre': 'Electronic',
                'position': (t0 % 243), 'total_time': 243, 'sampled_at': t0, 'shuffle': 'off', 'repeat': 'off',
                'volume': 40, 'app': 'Music', 'app_id': 'com.apple.Music', 'mock': True,
                'can': {k: True for k in ('play_pause', 'next', 'previous', 'volume_up', 'volume_down')},
                'artwork_url': f"/api/backdrop/{bg[0]['file']}" if bg else None}
    if not C.nowplaying_configured():
        if C.DEMO:
            return nowplaying('1')
        return {'available': False, 'configured': False, 'device': 'HomePod', 'device_state': 'idle',
                'error': 'now playing not configured (set NP_DEVICE_ID for the sidecar, or NP_URL)'}
    try:
        s = get_json(NP_URL + '/state', timeout=2)
    except Exception as e:  # noqa: BLE001 — sidecar down = clean "unavailable", never an error for the UI
        return {'available': False, 'device': 'HomePod', 'device_state': 'idle', 'error': f'sidecar: {e}'}
    h = s.pop('artwork_hash', None)
    s['artwork_url'] = f'/api/nowplaying/artwork?h={h}' if h else None
    s['now'] = time.time()
    return s


def np_artwork():
    with urllib.request.urlopen(NP_URL + '/artwork', timeout=5) as r:
        return r.read(), r.headers.get('content-type', 'image/jpeg')


def np_cmd(raw):
    req = urllib.request.Request(NP_URL + '/cmd', data=raw, headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
    except Exception as e:  # noqa: BLE001
        return 503, {'error': f'sidecar: {e}'}


# ---------------------------------------------------------------- http
class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body: bytes, ctype='application/json', cache='no-store'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _authed(self):
        import hmac
        return C.push_configured() and hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {C.PUSH_TOKEN}')

    def do_GET(self):  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)
        try:
            if p == '/api/config':
                return self._json(dash_config())
            if p == '/api/weather':
                return self._json(cached('weather', 600, weather))
            if p == '/api/photos':
                return self._json(cached('photos', 900, photos))
            if p.startswith('/api/photo/'):
                aid = p.rsplit('/', 1)[1]
                size = q.get('size', ['preview'])[0]
                body, ct = cached(f'img:{aid}:{size}', 3600, lambda: immich_image(aid, size))
                return self._send(200, body, ct, 'public, max-age=86400')
            if p == '/api/backdrops':
                return self._json(backdrops())
            if p.startswith('/api/backdrop/'):
                f = (BG_DIR / p.rsplit('/', 1)[1]).resolve()
                if f.parent != BG_DIR.resolve() or not f.is_file():
                    return self._json({'error': 'not found'}, 404)
                return self._send(200, f.read_bytes(), 'image/jpeg', 'public, max-age=604800')
            if p == '/api/server':
                if METRICS is None:
                    raise NotConfigured('server stats off (DASH_SERVER_STATS=0)')
                return self._json(METRICS.snapshot())
            if p == '/api/calendar':
                return self._json(calendar_data())
            if p == '/api/home':
                h = load_push('home') if C.push_configured() else None
                if h is None and not C.DEMO:
                    raise NotConfigured('home not configured (an agent pushes it with DASH_PUSH_TOKEN, e.g. dash/mac-agent)')
                return self._json(h or mock_home())
            if p == '/api/nowplaying':
                return self._json(nowplaying(q.get('mock', [''])[0]))
            if p == '/api/nowplaying/artwork':
                try:
                    body, ct = np_artwork()
                except Exception:  # noqa: BLE001
                    return self._json({'error': 'no artwork'}, 404)
                # URL carries the content hash (?h=), so it's safe to cache hard.
                return self._send(200, body, ct, 'public, max-age=86400' if q.get('h') else 'no-store')
            if p == '/api/settings':
                return self._json(load_settings())
            if p == '/api/cmd':  # remote debug key queue (web/src/lib/input.ts startRemote); POST needs DASH_DEBUG=1
                qd = REMOTE_Q.get(q.get('c', ['xbox'])[0])
                return self._json(qd.popleft() if qd else None)
            if p == '/api/home/commands':  # Mac agent drains this
                if not C.push_configured():
                    return self._json({'configured': False, 'error': 'DASH_PUSH_TOKEN not set'}, 503)
                if not self._authed():
                    return self._json({'error': 'unauthorized'}, 401)
                cmds = list(HOME_QUEUE)
                HOME_QUEUE.clear()
                return self._json(cmds)
            return self._static(p)
        except NotConfigured as e:
            return self._json({'configured': False, 'error': str(e)}, 503)
        except Exception as e:  # noqa: BLE001
            return self._json({'error': str(e)}, 502)

    def do_POST(self):  # noqa: N802
        p = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        if p == '/log':
            C.LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(C.LOG_FILE, 'a') as f:
                f.write(f"{datetime.now().isoformat(timespec='seconds')} {self.client_address[0]} {raw.decode(errors='replace')}\n")
            return self._send(204, b'')
        if p in ('/api/push/calendar', '/api/push/home'):
            if not C.push_configured():
                return self._json({'configured': False, 'error': 'DASH_PUSH_TOKEN not set'}, 503)
            if not self._authed():
                return self._json({'error': 'unauthorized'}, 401)
            data = json.loads(raw)
            if p.endswith('/home'):
                data = normalize_home(data)
            else:
                for e in data.get('events', []):
                    e['calendar'] = calendar_label(e.get('calendar', ''))
            data['updatedAt'] = time.time()
            (STATE / f"{p.rsplit('/', 1)[1]}.json").write_text(json.dumps(data))
            return self._json({'ok': True})
        if p == '/api/settings':
            return self._json(save_settings(json.loads(raw or b'{}')))
        if p == '/api/cmd':
            if not C.DEBUG:
                return self._json({'error': 'not found'}, 404)
            name = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('c', ['xbox'])[0]
            REMOTE_Q.setdefault(name, deque(maxlen=20)).append(json.loads(raw))
            return self._json({'queued': True})
        if p == '/api/nowplaying/cmd':
            code, body = np_cmd(raw)
            return self._json(body, code)
        if p == '/api/home/command':
            if not C.push_configured():
                return self._json({'configured': False, 'error': 'home control needs the Mac agent (DASH_PUSH_TOKEN)'}, 503)
            cmd = json.loads(raw)
            cmd['at'] = time.time()
            HOME_QUEUE.append(cmd)
            return self._json({'queued': True, 'note': 'executed by the Mac agent within ~2 s'})
        return self._json({'error': 'not found'}, 404)

    def _static(self, p):
        f = (DIST / p.lstrip('/')).resolve()
        if not str(f).startswith(str(DIST)) or not f.is_file():
            f = DIST / 'index.html'
        if not f.exists():
            return self._send(503, b'web/dist missing - run npm run build', 'text/plain')
        cache = 'public, max-age=31536000, immutable' if '/assets/' in p else 'no-cache'
        return self._send(200, f.read_bytes(), MIME.get(f.suffix, 'application/octet-stream'), cache)


def features():
    """Which tabs / Overview tiles have a data source. The UI hides the rest (polled with /api/config, so a tab appears
    once a first push arrives). One place decides this:

    calendar  ICS feeds configured, or DASH_PUSH_TOKEN set and a calendar push received
    home      DASH_PUSH_TOKEN set and a home push received (an agent has to send it)
    photos    IMMICH_URL + IMMICH_API_KEY
    music     now-playing sidecar configured (NP_DEVICE_ID or NP_URL)
    weather   DASH_LAT + DASH_LON
    server    host metrics on (DASH_SERVER_STATS, default 1 where /proc exists)
    DASH_DEMO=1 turns every one on, with sample data where the source is missing.
    """
    push = C.push_configured()
    f = {'calendar': C.ics_configured() or (push and (STATE / 'calendar.json').exists()),
         'home': push and (STATE / 'home.json').exists(),
         'photos': C.photos_configured(),
         'music': C.nowplaying_configured(),
         'weather': C.weather_configured(),
         'server': METRICS is not None}
    if C.DEMO:
        f = {k: True if k != 'server' else v for k, v in f.items()}
    return f


def dash_config():
    """GET /api/config: household clock zone + which optional data sources are configured.

    timeZone is omitted when it's only a UTC default (typical in containers), so the UI uses the weather location's zone.
    """
    tz = C.server_timezone()
    explicit = bool(C.env('DASH_TZ') or C.env('JELLYSHELL_TZ') or C.env('TZ'))
    out = {'serverTimeMs': int(time.time() * 1000), 'features': features(), 'demo': C.DEMO,
           'configured': {'weather': C.weather_configured(), 'photos': C.photos_configured(),
                          'push': C.push_configured(), 'nowplaying': C.nowplaying_configured(), 'calendar': load_push('calendar') is not None,
                          'ics': C.ics_configured(), 'home': load_push('home') is not None}}
    if explicit or tz not in ('UTC', 'Etc/UTC', 'Etc/Universal', 'Universal'):
        out['timeZone'] = tz
    return out


if __name__ == '__main__':
    print('jellyshell-dash: ' + C.summary(), flush=True)
    print(f'jellyshell-dash on http://{BIND}:{PORT}', flush=True)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
