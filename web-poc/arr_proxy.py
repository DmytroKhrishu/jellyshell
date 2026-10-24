"""Server-side proxy for Seerr (requests) and Sonarr/Radarr/qBittorrent (read-only downloads).

URLs and API keys come from config.py (env / .env, optionally ARR_CONFIG_DIR) and never leave this process.
A service without URL+key is off: its routes answer 503 {"error": "<service> not configured"}.
The browser identifies itself with its Jellyfin token (header X-Jellyfin-Token); we verify it against
Jellyfin (/Users/Me) and map the Jellyfin user to the Seerr user (jellyfinUserId), so requests and
"my requests" are attributed to the real user, not the admin key owner.

Routes (all JSON):
  GET  /api/seerr/<allow-listed path>   -> Seerr /api/v1/<path>
  GET  /api/seerr/me                    -> {seerrUserId, displayName} for the caller
  GET  /api/seerr/myrequests            -> caller's latest requests, enriched with title/poster
  POST /api/seerr/request               -> Seerr POST /request with userId forced to the caller
  DELETE /api/seerr/request/<id>        -> only the caller's own requests that are still pending
  GET  /api/downloads                   -> aggregated queue (Sonarr+Radarr, live speed from qB) + recent imports
  GET  /api/calendar?start=&end=        -> merged Sonarr episode + Radarr cinema/digital/physical release dates
"""
import datetime as dt
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar
import config

SEERR = config.SEERR_URL + '/api/v1' if config.SEERR_URL else ''
SONARR = config.SONARR_URL + '/api/v3' if config.SONARR_URL else ''
RADARR = config.RADARR_URL + '/api/v3' if config.RADARR_URL else ''
QB = config.QB_URL
JF = config.JELLYFIN_URL

# Every secret this process holds, so _req / logs can scrub them from upstream error text.
KEYS = {'seerr': config.SEERR_API_KEY, 'sonarr': config.SONARR_API_KEY, 'radarr': config.RADARR_API_KEY}


def require(service):
    """Raise 503 when an integration isn't configured (missing URL or key)."""
    if not config.configured().get(service):
        raise Upstream(503, f'{service} not configured')


def downloads_configured():
    """Downloads + the release calendar need at least one of Sonarr / Radarr (qBittorrent only adds live speed)."""
    c = config.configured()
    return c['sonarr'] or c['radarr']

# GET paths the browser may reach through /api/seerr/* (regex on the path after /api/v1).
SEERR_GET = [
    r'/discover/(trending|movies|tv|movies/upcoming|tv/upcoming)',
    r'/search',
    r'/movie/\d+',
    r'/tv/\d+',
    r'/tv/\d+/season/\d+',
    r'/(movie|tv)/\d+/(recommendations|similar)',
    r'/movie/\d+/ratingscombined',
    r'/tv/\d+/ratings',
    r'/request/count',
    r'/person/\d+',
    r'/person/\d+/combined_credits',
]


class Upstream(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def _req(url, key=None, method='GET', body=None, headers=None, timeout=15):
    h = dict(headers or {})
    if key:
        h['X-Api-Key'] = key
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout)
        txt = r.read()
        return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='replace')[:400]
        for k in KEYS.values():
            if k:
                msg = msg.replace(k, '<key>')
        raise Upstream(e.code, msg) from None
    except Exception as e:  # noqa: BLE001
        raise Upstream(502, f'upstream unreachable: {type(e).__name__}') from None


def seerr(path, method='GET', body=None):
    require('seerr')
    return _req(SEERR + path, KEYS['seerr'], method, body)


# ---------------- user mapping (Jellyfin token -> Seerr user) ----------------
_users = {}  # token -> (expires, info)
_ulock = threading.Lock()


def whoami(token, claimed_user=''):
    """Verify the Jellyfin token and map to the Seerr user. Returns dict or raises Upstream(401).

    Real user tokens resolve via /Users/Me (so the caller can't claim someone else). An API-key token
    (used by the test harness) has no user: then the claimed X-Jellyfin-User id is looked up with it.
    """
    if not token:
        raise Upstream(401, 'missing X-Jellyfin-Token')
    now = time.time()
    ck = token + '|' + claimed_user
    with _ulock:
        hit = _users.get(ck)
        if hit and hit[0] > now:
            return hit[1]
    try:
        me = _req(JF + '/Users/Me', headers={'X-Emby-Token': token})
    except Upstream as e:
        if e.code in (401, 403) or not re.fullmatch(r'[0-9a-fA-F-]{32,36}', claimed_user or ''):
            raise Upstream(401, 'invalid Jellyfin token') from None
        me = _req(f'{JF}/Users/{claimed_user}', headers={'X-Emby-Token': token})
    if not me or 'Id' not in me:
        raise Upstream(401, 'invalid Jellyfin token')
    jf_id = me['Id'].replace('-', '').lower()
    # Without Seerr this is just a verified Jellyfin identity (subtitle tools, release dates use it too).
    users = seerr('/user?take=500')['results'] if config.configured()['seerr'] else []
    match = next((u for u in users if (u.get('jellyfinUserId') or '').replace('-', '').lower() == jf_id), None)
    perms = int((match or {}).get('permissions') or 0)
    info = {
        'jellyfinUserId': jf_id,
        'jellyfinName': me.get('Name'),
        'seerrUserId': match['id'] if match else None,
        'displayName': (match or {}).get('displayName') or me.get('Name'),
        'attributed': bool(match),
        # Seerr ADMIN | MANAGE_REQUESTS | REQUEST_ADVANCED: may pick server / quality profile / folder.
        # The proxy files requests with the admin API key, so Seerr can't check this itself: we do.
        'advanced': bool(match) and bool(perms & (2 | 16 | 8192)),
    }
    with _ulock:
        _users[ck] = (now + 600, info)
    return info


# ---------------- title cache for requests ----------------
_titles = {}


def _title_info(media_type, tmdb_id):
    k = (media_type, tmdb_id)
    hit = _titles.get(k)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        d = seerr(f'/{media_type}/{tmdb_id}')
        info = {
            'title': d.get('title') or d.get('name'),
            'posterPath': d.get('posterPath'),
            'backdropPath': d.get('backdropPath'),
            'year': (d.get('releaseDate') or d.get('firstAirDate') or '')[:4],
        }
    except Upstream:
        info = {'title': f'TMDB {tmdb_id}', 'posterPath': None, 'backdropPath': None, 'year': ''}
    _titles[k] = (time.time() + 3600, info)
    return info


def my_requests(token):
    me = whoami(*token)
    if not me['seerrUserId']:
        return {'user': me, 'results': []}
    rs = seerr(f'/request?take=20&skip=0&sort=added&filter=all&requestedBy={me["seerrUserId"]}')['results']
    out = []
    for r in rs:
        m = r.get('media') or {}
        mt = r.get('type') or m.get('mediaType')
        tmdb = m.get('tmdbId')
        info = _title_info(mt, tmdb) if tmdb else {}
        out.append({
            'id': r['id'],
            'status': r['status'],
            'createdAt': r.get('createdAt'),
            'mediaType': mt,
            'tmdbId': tmdb,
            'mediaStatus': m.get('status'),
            'jellyfinMediaId': m.get('jellyfinMediaId'),
            'seasons': [s.get('seasonNumber') for s in r.get('seasons') or []],
            **info,
        })
    return {'user': me, 'results': out}


# ---------------- release dates (batched + cached for discover/search cards) ----------------
# TMDB release_dates types: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV.
_REL_TYPES = {1: 'premiere', 2: 'limited', 3: 'theatrical', 4: 'digital', 5: 'physical', 6: 'tv'}
_dates = {}  # (type, id) -> (expires, info)
_dlock = threading.Lock()
_region = {'at': 0, 'v': None}


def seerr_region():
    """Discover region configured in Seerr (Settings → General), else US. Cached 10 min."""
    if time.time() - _region['at'] > 600:
        try:
            _region['v'] = (seerr('/settings/main').get('region') or '').upper() or None
        except Upstream:
            _region['v'] = None
        _region['at'] = time.time()
    return _region['v'] or 'US'


def _ymd(s):
    return (s or '')[:10] or None


def movie_dates(d, region=None):
    """One date per release type: the date in `region` (then US), else the earliest worldwide."""
    region = region or seerr_region()
    by_type = {}  # type -> {'region': date, ...}
    for r in ((d.get('releases') or {}).get('results') or []):
        cc = r.get('iso_3166_1')
        for x in r.get('release_dates') or []:
            t, day = x.get('type'), _ymd(x.get('release_date'))
            if t in _REL_TYPES and day:
                cur = by_type.setdefault(t, {})
                if cc not in cur or day < cur[cc][0]:
                    cur[cc] = (day, x.get('note') or '')
    out = {}
    for t, regions in by_type.items():
        for cc in (region, 'US'):
            if cc in regions:
                out[_REL_TYPES[t]] = {'date': regions[cc][0], 'region': cc, 'note': regions[cc][1]}
                break
        else:
            cc, (day, note) = min(regions.items(), key=lambda kv: kv[1][0])
            out[_REL_TYPES[t]] = {'date': day, 'region': cc, 'note': note}
    return {'type': 'movie', 'id': d.get('id'), 'status': d.get('status'), 'releaseDate': _ymd(d.get('releaseDate')), 'releases': out}


def tv_dates(d):
    def ep(e):
        return {'date': _ymd(e.get('airDate')), 'season': e.get('seasonNumber'), 'episode': e.get('episodeNumber'), 'name': e.get('name')} if e else None
    return {
        'type': 'tv', 'id': d.get('id'), 'status': d.get('status'), 'firstAirDate': _ymd(d.get('firstAirDate')),
        'lastAirDate': _ymd(d.get('lastAirDate')), 'nextEpisode': ep(d.get('nextEpisodeToAir')), 'lastEpisode': ep(d.get('lastEpisodeToAir')),
        'inProduction': d.get('inProduction'),
    }


def _dates_one(kind, tmdb_id):
    k = (kind, tmdb_id)
    now = time.time()
    with _dlock:
        hit = _dates.get(k)
        if hit and hit[0] > now:
            return hit[1]
    try:
        d = seerr(f'/{kind}/{tmdb_id}')
        info = movie_dates(d) if kind == 'movie' else tv_dates(d)
        ttl = 6 * 3600
    except Upstream:
        info, ttl = None, 300
    with _dlock:
        if len(_dates) > 4000:
            _dates.clear()
        _dates[k] = (now + ttl, info)
    return info


def release_dates(query):
    """GET /api/seerr/dates?movie=1,2&tv=3 -> {"movie:1": {...}, "tv:3": {...}} (max 40 ids, 6 h cache, 6 parallel)."""
    q = urllib.parse.parse_qs(query)
    want = []
    for kind in ('movie', 'tv'):
        for v in ','.join(q.get(kind, [])).split(','):
            if v.isdigit() and (kind, int(v)) not in want:
                want.append((kind, int(v)))
    if len(want) > 40:
        raise Upstream(400, 'at most 40 ids per call')
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(lambda kv: _dates_one(*kv), want))
    return {f'{k}:{i}': r for (k, i), r in zip(want, res) if r}


# ---------------- advanced request options (quality profile, root folder, minimum availability) ----------------
_svc = {}  # kind -> (expires, data)
MIN_AVAIL = ('announced', 'inCinemas', 'released')


def service_options(kind):
    """Servers configured in Seerr for movie (Radarr) or tv (Sonarr) with their profiles/folders and Seerr defaults. Cached 5 min."""
    hit = _svc.get(kind)
    if hit and hit[0] > time.time():
        return hit[1]
    svc = 'radarr' if kind == 'movie' else 'sonarr'
    settings = {s['id']: s for s in seerr(f'/settings/{svc}')}
    servers = []
    for s in seerr(f'/service/{svc}'):
        if s.get('is4k'):
            continue  # 4K servers need REQUEST_4K: not offered
        det = seerr(f'/service/{svc}/{s["id"]}')
        st = settings.get(s['id'], {})
        servers.append({
            'id': s['id'], 'name': s.get('name'), 'isDefault': bool(s.get('isDefault')),
            'profiles': [{'id': p['id'], 'name': p['name']} for p in det.get('profiles') or []],
            'rootFolders': [{'id': f['id'], 'path': f['path'], 'freeSpace': f.get('freeSpace')} for f in det.get('rootFolders') or []],
            'languageProfiles': [{'id': p['id'], 'name': p['name']} for p in det.get('languageProfiles') or []] or None,
            'activeProfileId': s.get('activeProfileId'), 'activeDirectory': s.get('activeDirectory'),
            'activeLanguageProfileId': s.get('activeLanguageProfileId'),
            **({'minimumAvailability': st.get('minimumAvailability') or 'released'} if kind == 'movie' else {}),
        })
    servers.sort(key=lambda x: not x['isDefault'])
    _svc[kind] = (time.time() + 300, servers)
    return servers


def request_options(token, query):
    me = whoami(*token)
    kind = (urllib.parse.parse_qs(query).get('type') or [''])[0]
    if kind not in ('movie', 'tv'):
        raise Upstream(400, 'type=movie|tv required')
    if not me['advanced']:
        return {'advanced': False, 'servers': []}
    return {'advanced': True, 'servers': service_options(kind)}


def build_request(me, body, public=False):
    """Validate the browser's body into the Seerr POST /request body. Returns (clean, extras) where extras holds
    things Seerr can't take (minimumAvailability, applied to Radarr afterwards)."""
    if not isinstance(body, dict) or body.get('mediaType') not in ('movie', 'tv') or not isinstance(body.get('mediaId'), int):
        raise Upstream(400, 'mediaType (movie|tv) and integer mediaId required')
    clean = {'mediaType': body['mediaType'], 'mediaId': body['mediaId'], 'is4k': False}
    if body['mediaType'] == 'tv':
        s = body.get('seasons')
        if s == 'all' or (isinstance(s, list) and s and all(isinstance(x, int) for x in s)):
            clean['seasons'] = s
        else:
            raise Upstream(400, 'seasons must be "all" or a list of season numbers')
    if me['seerrUserId']:
        clean['userId'] = me['seerrUserId']
    elif public:
        # On the internet, never file as the API-key owner (the admin) for an unlinked Jellyfin user.
        raise Upstream(403, "Requests aren't enabled for your account")
    extras = {}
    adv_keys = [k for k in ('serverId', 'profileId', 'rootFolder', 'languageProfileId', 'minimumAvailability') if body.get(k) is not None]
    if adv_keys:
        # The admin API key files the request, so Seerr's own REQUEST_ADVANCED check never runs: enforce it here.
        if not me.get('advanced'):
            raise Upstream(403, 'advanced request options need the Seerr "Advanced requests" permission')
        servers = service_options(clean['mediaType'])
        sid = body.get('serverId')
        srv = next((s for s in servers if s['id'] == sid), None) if sid is not None else next((s for s in servers if s['isDefault']), servers[0] if servers else None)
        if not srv:
            raise Upstream(400, 'unknown serverId')
        clean['serverId'] = srv['id']
        pid = body.get('profileId')
        if pid is not None:
            if not any(p['id'] == pid for p in srv['profiles']):
                raise Upstream(400, 'profileId is not a quality profile of that server')
            clean['profileId'] = pid
        rf = body.get('rootFolder')
        if rf is not None:
            if not any(f['path'] == rf for f in srv['rootFolders']):
                raise Upstream(400, 'rootFolder is not a root folder of that server')
            clean['rootFolder'] = rf
        lp = body.get('languageProfileId')
        if lp is not None:
            if clean['mediaType'] != 'tv' or not any(p['id'] == lp for p in srv.get('languageProfiles') or []):
                raise Upstream(400, 'invalid languageProfileId')
            clean['languageProfileId'] = lp
        ma = body.get('minimumAvailability')
        if ma is not None:
            if clean['mediaType'] != 'movie' or ma not in MIN_AVAIL:
                raise Upstream(400, 'minimumAvailability must be announced|inCinemas|released (movies only)')
            if ma != srv.get('minimumAvailability'):
                extras['minimumAvailability'] = ma
    return clean, extras


def _apply_min_availability(tmdb_id, value, tries=12, wait=5):
    """Seerr's POST /request has no minimumAvailability (it always uses the server setting), and it adds the movie
    to Radarr asynchronously after approval. Poll Radarr for the movie, then PUT the new value."""
    for _ in range(tries):
        try:
            ms = _req(f'{RADARR}/movie?tmdbId={tmdb_id}', KEYS.get('radarr'))
            if ms:
                m = ms[0]
                if m.get('minimumAvailability') != value:
                    m['minimumAvailability'] = value
                    _req(f'{RADARR}/movie/{m["id"]}', KEYS.get('radarr'), 'PUT', m)
                print(f'arr_proxy: radarr movie {m["id"]} minimumAvailability={value}', flush=True)
                return True
        except Upstream as e:
            print(f'arr_proxy: minimumAvailability poll failed: {e}', flush=True)
        time.sleep(wait)
    print(f'arr_proxy: tmdb {tmdb_id} not in Radarr yet (pending approval?): minimumAvailability not applied', flush=True)
    return False


def create_request(token, body, public=False):
    me = whoami(*token)
    clean, extras = build_request(me, body, public)
    # Seerr happily files duplicate requests for media that is already available/requested: refuse here.
    d = seerr(f'/{clean["mediaType"]}/{clean["mediaId"]}')
    mi = d.get('mediaInfo') or {}
    if clean['mediaType'] == 'movie':
        if mi.get('status') in (2, 3, 4, 5):
            raise Upstream(409, 'already requested or available')
    else:
        taken = {s['seasonNumber'] for s in mi.get('seasons') or [] if s.get('status') in (2, 3, 4, 5)}
        for r in mi.get('requests') or []:
            if r.get('status') not in (3, 4):
                taken |= {s['seasonNumber'] for s in r.get('seasons') or []}
        free = [s['seasonNumber'] for s in d.get('seasons') or [] if s.get('seasonNumber', 0) > 0 and s['seasonNumber'] not in taken]
        want = free if clean['seasons'] == 'all' else [n for n in clean['seasons'] if n in free]
        if not want:
            raise Upstream(409, 'those seasons are already requested or available')
        clean['seasons'] = 'all' if clean['seasons'] == 'all' and not taken else want
    res = seerr('/request', 'POST', clean)
    ma = extras.get('minimumAvailability')
    if ma and RADARR:
        # Only the one Radarr this proxy talks to (RADARR) can be updated; Seerr may still be waiting for approval.
        threading.Thread(target=_apply_min_availability, args=(clean['mediaId'], ma), daemon=True).start()
    return {'request': {'id': res.get('id'), 'status': res.get('status')}, 'attributedTo': me['displayName'], 'attributed': me['attributed'],
            **({'minimumAvailability': 'scheduled'} if ma else {})}


def delete_request(token, req_id):
    me = whoami(*token)
    r = seerr(f'/request/{req_id}')
    if not me['seerrUserId'] or (r.get('requestedBy') or {}).get('id') != me['seerrUserId']:
        raise Upstream(403, 'not your request')
    seerr(f'/request/{req_id}', 'DELETE')
    return {'deleted': req_id}


_USER_KEEP = ('id', 'displayName', 'avatar')


def scrub_users(o):
    """Seerr embeds full user records (email, jellyfin username, permissions...) in requests: keep id + displayName."""
    if isinstance(o, dict):
        if 'email' in o or 'jellyfinUserId' in o or 'permissions' in o and 'userType' in o:
            return {k: o.get(k) for k in _USER_KEEP if k in o}
        return {k: scrub_users(v) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub_users(v) for v in o]
    return o


def seerr_get(sub, query):
    if not any(re.fullmatch(p, sub) for p in SEERR_GET):
        raise Upstream(403, 'path not allowed')
    q = urllib.parse.urlencode([(k, v) for k, vs in urllib.parse.parse_qs(query).items() for v in vs], quote_via=urllib.parse.quote)
    return seerr(sub + ('?' + q if q else ''))


# ---------------- downloads ----------------
_qb = {'opener': None, 'creds': None, 'ok': False}
_qblock = threading.Lock()


def _qb_creds():
    # Explicit QBITTORRENT_USERNAME/PASSWORD, else the creds in Sonarr's download client settings (ARR_CONFIG_DIR).
    if config.QB_USER or config.QB_PASS:
        return config.QB_USER, config.QB_PASS
    creds = config.qb_creds_from_sonarr()
    if creds is None:
        raise Upstream(503, 'qBittorrent credentials not configured')
    return creds


def _qb_get(path):
    if not QB:
        raise Upstream(503, 'qbittorrent not configured')
    with _qblock:
        for attempt in (0, 1):
            if not _qb['ok']:
                if _qb['creds'] is None:
                    _qb['creds'] = _qb_creds()
                op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                u, p = _qb['creds']
                data = urllib.parse.urlencode({'username': u, 'password': p}).encode()
                resp = op.open(urllib.request.Request(QB + '/api/v2/auth/login', data=data, headers={'Referer': QB + '/'}), timeout=8)
                r = resp.read()
                # qB <5 answers 200 "Ok."; qB 5 answers 204 with the SID cookie. "Fails." = bad creds.
                if resp.status not in (200, 204) or r.strip() == b'Fails.':
                    _qb['creds'] = None
                    raise Upstream(502, 'qBittorrent login failed')
                _qb['opener'], _qb['ok'] = op, True
            try:
                return json.loads(_qb['opener'].open(urllib.request.Request(QB + path, headers={'Referer': QB + '/'}), timeout=8).read())
            except urllib.error.HTTPError as e:
                if e.code == 403 and attempt == 0:
                    _qb['ok'] = False
                    continue
                raise Upstream(502, f'qBittorrent {e.code}') from None
    return None


def _poster(images):
    for im in images or []:
        if im.get('coverType') == 'poster':
            return im.get('remoteUrl') or None
    return None


def _status(rec, t):
    st = (rec.get('trackedDownloadState') or '').lower()
    tds = (rec.get('trackedDownloadStatus') or '').lower()
    s = (rec.get('status') or '').lower()
    if st in ('importpending', 'importing', 'importblocked'):
        return 'importing' if st != 'importblocked' else 'failed'
    if st in ('failedpending', 'failed') or s in ('failed', 'warning') and tds == 'error':
        return 'failed'
    qs = (t or {}).get('state', '')
    if qs in ('stalledDL', 'metaDL') or tds == 'warning':
        return 'stalled'
    if s in ('queued', 'paused', 'delay', 'downloadclientunavailable') or qs in ('queuedDL', 'pausedDL', 'stoppedDL'):
        return 'queued'
    if s == 'completed':
        return 'importing'
    return 'downloading'


def _timeleft_s(tl):
    # "1.02:03:04" or "02:03:04"
    if not tl:
        return None
    m = re.fullmatch(r'(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.\d+)?', tl)
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


def _arr_queue(base, key, extra):
    if not key:
        return []
    out, page = [], 1
    while page <= 5:
        d = _req(f'{base}/queue?page={page}&pageSize=100&{extra}', key)
        out += d.get('records', [])
        if len(out) >= d.get('totalRecords', 0):
            break
        page += 1
    return out


# ---------------- Jellyfin library match (for clickable download rows) ----------------
_lib = {}  # user id -> (expires, {('tvdb'|'tmdb'|'imdb', kind, id): jfId})
_seasons = {}  # series jf id -> (expires, {seasonNumber: seasonJfId})
_liblock = threading.Lock()


def _jf_user_token(token):
    me = whoami(*token)
    return token[0], me['jellyfinUserId']


def library_index(token):
    """Provider-id index of the caller's Series + Movies (one Jellyfin call, cached 60 s)."""
    tok, uid = _jf_user_token(token)
    now = time.time()
    with _liblock:
        hit = _lib.get(uid)
        if hit and hit[0] > now:
            return hit[1]
    d = _req(f'{JF}/Items?userId={uid}&Recursive=true&IncludeItemTypes=Series,Movie&Fields=ProviderIds&EnableImages=false&EnableUserData=false',
             headers={'X-Emby-Token': tok}, timeout=20)
    idx = {}
    for it in d.get('Items', []):
        kind = 'tv' if it.get('Type') == 'Series' else 'movie'
        for k, v in (it.get('ProviderIds') or {}).items():
            if k.lower() in ('tvdb', 'tmdb', 'imdb') and v:
                idx.setdefault((k.lower(), kind, str(v).lower()), it['Id'])
    with _liblock:
        _lib[uid] = (now + 60, idx)
    return idx


def _season_id(token, series_id, number):
    if not isinstance(number, int):
        return None
    now = time.time()
    hit = _seasons.get(series_id)
    if not hit or hit[0] <= now:
        tok, uid = _jf_user_token(token)
        try:
            d = _req(f'{JF}/Shows/{series_id}/Seasons?userId={uid}', headers={'X-Emby-Token': tok})
        except Upstream:
            return None
        hit = (now + 300, {s.get('IndexNumber'): s['Id'] for s in d.get('Items', []) if s.get('IndexNumber') is not None})
        _seasons[series_id] = hit
    return hit[1].get(number)


def attach_library(token, rows, errors):
    """Adds jellyfinId (+ jellyfinSeasonId for episodes) to queue/recent rows whose title is in the library."""
    try:
        idx = library_index(token)
    except Exception as e:  # noqa: BLE001
        errors.append('jellyfin match: ' + str(e)[:120])
        return rows
    out = []
    for r in rows:
        r = dict(r)
        kind = 'tv' if r.get('kind') == 'episode' else 'movie'
        ids = r.pop('_ids', None) or {'tmdb': r.get('tmdbId')}
        jf = next((idx.get((k, kind, str(v).lower())) for k, v in ids.items() if v and idx.get((k, kind, str(v).lower()))), None)
        if jf:
            r['jellyfinId'] = jf
            if kind == 'tv':
                r['jellyfinSeasonId'] = _season_id(token, jf, r.get('seasonNumber'))
        out.append(r)
    return out


def _ids(obj):
    return {'tvdb': obj.get('tvdbId'), 'tmdb': obj.get('tmdbId'), 'imdb': obj.get('imdbId')}


def downloads(token=None):
    errors = []
    torrents = {}
    try:
        for t in (_qb_get('/api/v2/torrents/info') if QB else None) or []:  # qBittorrent is optional
            torrents[t['hash'].lower()] = t
    except Exception as e:  # noqa: BLE001
        errors.append('qbittorrent: ' + str(e)[:120])
    items = []
    for svc, base, extra in (('sonarr', SONARR, 'includeSeries=true&includeEpisode=true'), ('radarr', RADARR, 'includeMovie=true')):
        try:
            recs = _arr_queue(base, KEYS.get(svc), extra)
        except Exception as e:  # noqa: BLE001
            errors.append(f'{svc}: ' + str(e)[:120])
            continue
        # One torrent can hold a whole season: group Sonarr records by downloadId.
        groups = {}
        for r in recs:
            groups.setdefault(r.get('downloadId') or f'{svc}-{r.get("id")}', []).append(r)
        for did, rs in groups.items():
            r = rs[0]
            t = torrents.get((r.get('downloadId') or '').lower())
            size = r.get('size') or (t or {}).get('size') or 0
            left = r.get('sizeleft') if r.get('sizeleft') is not None else (t or {}).get('amount_left', 0)
            pct = (t['progress'] * 100) if t else ((1 - left / size) * 100 if size else 0)
            if svc == 'sonarr':
                s = r.get('series') or {}
                eps = sorted((x.get('episode') or {}).get('episodeNumber', 0) for x in rs)
                ep = r.get('episode') or {}
                sn = ep.get('seasonNumber', r.get('seasonNumber'))
                if len(rs) > 1:
                    sub = f'S{sn:02d} · {len(rs)} episodes' if isinstance(sn, int) else f'{len(rs)} episodes'
                elif ep:
                    sub = f'S{ep.get("seasonNumber", 0):02d}E{ep.get("episodeNumber", 0):02d} · {ep.get("title", "")}'
                else:
                    sub = ''
                title, poster, tmdb = s.get('title') or r.get('title'), _poster(s.get('images')), s.get('tmdbId')
                ids = _ids(s)
            else:
                m = r.get('movie') or {}
                title, poster, tmdb = m.get('title') or r.get('title'), _poster(m.get('images')), m.get('tmdbId')
                sub = str(m.get('year') or '')
                ids, sn = _ids(m), None
            eta = (t or {}).get('eta')
            eta = eta if isinstance(eta, int) and 0 < eta < 8640000 else _timeleft_s(r.get('timeleft'))
            msgs = [m for sm in (r.get('statusMessages') or []) for m in (sm.get('messages') or [])]
            items.append({
                'id': f'{svc}:{did}',
                'kind': 'episode' if svc == 'sonarr' else 'movie',
                'title': title,
                'subtitle': sub,
                'poster': poster,
                'tmdbId': tmdb,
                '_ids': ids,
                'seasonNumber': sn if isinstance(sn, int) else None,
                'status': _status(r, t),
                'percent': round(max(0.0, min(100.0, pct)), 1),
                'size': size,
                'sizeLeft': left,
                'speed': (t or {}).get('dlspeed', 0),
                'eta': eta,
                'quality': ((r.get('quality') or {}).get('quality') or {}).get('name'),
                'message': (r.get('errorMessage') or (msgs[0] if msgs else ''))[:160],
            })
    order = {'downloading': 0, 'stalled': 1, 'importing': 2, 'queued': 3, 'failed': 4}
    items.sort(key=lambda x: (order.get(x['status'], 9), -x['percent']))
    recent = recent_imports(errors)
    if token:
        items, recent = attach_library(token, items, errors), attach_library(token, recent, errors)
    else:
        items = [{k: v for k, v in x.items() if k != '_ids'} for x in items]
        recent = [{k: v for k, v in x.items() if k != '_ids'} for x in recent]
    return {'items': items, 'recent': recent, 'errors': errors, 'at': int(time.time())}


_recent = {'at': 0, 'data': []}


def demo_downloads(token=None):
    """Sample queue for UI testing (?demo=1): fake progress rows + the real recent-imports list."""
    t = time.time()
    p = (t / 3) % 100
    g = 1024 ** 3
    tmdb = 'https://image.tmdb.org/t/p/w342'
    items = [
        {'id': 'demo:1', 'kind': 'episode', 'title': 'Severance', 'subtitle': 'S02E03 · Who Is Alive?', 'poster': tmdb + '/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg',
         'status': 'downloading', 'percent': round(p, 1), 'size': int(2.4 * g), 'sizeLeft': int(2.4 * g * (1 - p / 100)), 'speed': 6_300_000, 'eta': int((100 - p) * 4), 'quality': 'WEBDL-1080p', 'message': ''},
        {'id': 'demo:2', 'kind': 'movie', 'title': 'Practical Magic 2', 'subtitle': '2026', 'poster': tmdb + '/ogwQOLbCfncjvBhFb5l0OmQH8KC.jpg',
         'status': 'stalled', 'percent': 41.7, 'size': 18 * g, 'sizeLeft': int(18 * g * 0.583), 'speed': 0, 'eta': None, 'quality': 'WEBDL-2160p', 'message': 'The download is stalled with no connections'},
        {'id': 'demo:3', 'kind': 'movie', 'title': 'Hope', 'subtitle': '2026', 'poster': tmdb + '/1n37BJchWHLiSYQkuFxe5KjB951.jpg',
         'status': 'importing', 'percent': 100.0, 'size': 9 * g, 'sizeLeft': 0, 'speed': 0, 'eta': None, 'quality': 'Bluray-1080p', 'message': ''},
        {'id': 'demo:4', 'kind': 'episode', 'title': 'Carrie', 'subtitle': 'S01 · 8 episodes', 'poster': None,
         'status': 'queued', 'percent': 0.0, 'size': 12 * g, 'sizeLeft': 12 * g, 'speed': 0, 'eta': None, 'quality': 'WEBDL-1080p', 'message': ''},
        # A show already in the library getting new episodes (clickable -> series page).
        {'id': 'demo:5', 'kind': 'episode', 'title': 'Reacher', 'subtitle': 'S01E02 · First Dance', 'poster': None, 'tmdbId': 108978,
         '_ids': {'tmdb': 108978}, 'seasonNumber': 1,
         'status': 'downloading', 'percent': round((p + 50) % 100, 1), 'size': int(1.6 * g), 'sizeLeft': int(1.6 * g * 0.5), 'speed': 3_100_000, 'eta': 240, 'quality': 'WEBDL-1080p', 'message': ''},
    ]
    errs = []
    recent = recent_imports(errs)
    if token:
        items, recent = attach_library(token, items, errs), attach_library(token, recent, errs)
    return {'items': items, 'recent': recent, 'errors': errs, 'at': int(t), 'demo': True}


def recent_imports(errors):
    if time.time() - _recent['at'] < 60:
        return _recent['data']
    out = []
    for svc, base, extra in (('sonarr', SONARR, 'includeSeries=true&includeEpisode=true'), ('radarr', RADARR, 'includeMovie=true')):
        if not KEYS.get(svc):
            continue
        try:
            d = _req(f'{base}/history?page=1&pageSize=10&sortKey=date&sortDirection=descending&eventType=3&{extra}', KEYS[svc])
        except Exception as e:  # noqa: BLE001
            errors.append(f'{svc} history: ' + str(e)[:120])
            continue
        for r in d.get('records', []):
            sn = None
            if svc == 'sonarr':
                s, ep = r.get('series') or {}, r.get('episode') or {}
                title, poster, tmdb = s.get('title'), _poster(s.get('images')), s.get('tmdbId')
                sub = f'S{ep.get("seasonNumber", 0):02d}E{ep.get("episodeNumber", 0):02d} · {ep.get("title", "")}' if ep else ''
                ids, sn = _ids(s), ep.get('seasonNumber')
            else:
                m = r.get('movie') or {}
                title, poster, tmdb, sub = m.get('title'), _poster(m.get('images')), m.get('tmdbId'), str(m.get('year') or '')
                ids = _ids(m)
            out.append({'id': f'{svc}:h{r.get("id")}', 'kind': 'episode' if svc == 'sonarr' else 'movie', 'title': title or r.get('sourceTitle'),
                        'subtitle': sub, 'poster': poster, 'tmdbId': tmdb, 'date': r.get('date'), '_ids': ids,
                        'seasonNumber': sn if isinstance(sn, int) else None,
                        'quality': ((r.get('quality') or {}).get('quality') or {}).get('name')})
    out.sort(key=lambda x: x.get('date') or '', reverse=True)
    _recent.update(at=time.time(), data=out[:10])
    return _recent['data']


# ---------------- release calendar (Sonarr + Radarr, read-only) ----------------
_cal = {}  # (start, end, uid) -> (expires, data)
_cal_lock = threading.Lock()
_DAY = re.compile(r'\d{4}-\d{2}-\d{2}')


def _local_day(iso_utc):
    """'2026-10-21T01:00:00Z' -> '2026-10-21' in the server's zone (this process' local zone = timedatectl)."""
    t = dt.datetime.fromisoformat(iso_utc.replace('Z', '+00:00'))
    return t.astimezone().strftime('%Y-%m-%d')


def _ep_range(nums):
    nums = sorted(nums)
    return f'E{nums[0]:02d}' if len(nums) == 1 else f'E{nums[0]:02d}–E{nums[-1]:02d}'


def _thumb(url):
    # Radarr hands out TMDB 'original' posters (~2000x3000); a list thumb needs w342.
    return url.replace('image.tmdb.org/t/p/original/', 'image.tmdb.org/t/p/w342/') if url else url


def calendar(token, start, end):
    """Merged release calendar. Episodes airing together (season drops) collapse into one event.

    Movies give up to three events (inCinemas / digitalRelease / physicalRelease), each its own row. Movie dates
    are date-only (Radarr sends midnight UTC), so their `date` is the UTC date and `at` is None.
    """
    if not (_DAY.fullmatch(start or '') and _DAY.fullmatch(end or '')):
        raise Upstream(400, 'start and end must be YYYY-MM-DD')
    uid = whoami(*token)['jellyfinUserId'] if token else ''
    key = (start, end, uid)
    now = time.time()
    with _cal_lock:
        hit = _cal.get(key)
        if hit and hit[0] > now:
            return hit[1]
    errors, events = [], []
    # Pad the UTC query by a day each side: the server zone can shift an airDateUtc across midnight.
    pad = dt.timedelta(days=1)
    s0 = (dt.date.fromisoformat(start) - pad).isoformat()
    e0 = (dt.date.fromisoformat(end) + pad).isoformat()
    if KEYS.get('sonarr'):
        try:
            eps = _req(f'{SONARR}/calendar?start={s0}&end={e0}&includeSeries=true&unmonitored=false', KEYS['sonarr'])
        except Upstream as e:
            errors.append('sonarr: ' + str(e)[:120])
            eps = []
        groups = {}
        for e in eps:
            if not e.get('airDateUtc') or not (start <= _local_day(e['airDateUtc']) <= end):
                continue
            groups.setdefault((e.get('seriesId'), e['airDateUtc'], e.get('seasonNumber')), []).append(e)
        for (sid, at, sn), es in groups.items():
            s = es[0].get('series') or {}
            nums = [x.get('episodeNumber', 0) for x in es]
            if len(es) == 1:
                sub = f'S{sn or 0:02d}E{nums[0]:02d} · {es[0].get("title") or "TBA"}'
            else:
                sub = f'S{sn or 0:02d}{_ep_range(nums)} · {len(es)} episodes'
            have = sum(1 for x in es if x.get('hasFile'))
            events.append({
                'id': f'sonarr:{sid}:{at}:{sn}',
                'kind': 'episode',
                'date': _local_day(at),
                'at': at,
                'runtime': es[0].get('runtime') or None,
                'title': s.get('title') or es[0].get('title'),
                'subtitle': sub,
                'count': len(es),
                'hasFile': have == len(es),
                'filesHave': have,
                'monitored': all(x.get('monitored') for x in es),
                'poster': _thumb(_poster(s.get('images'))),
                'tmdbId': s.get('tmdbId'),
                'tvdbId': s.get('tvdbId'),
                '_ids': _ids(s),
                'seasonNumber': sn if isinstance(sn, int) else None,
            })
    if KEYS.get('radarr'):
        try:
            movies = _req(f'{RADARR}/calendar?start={s0}&end={e0}&unmonitored=false', KEYS['radarr'])
        except Upstream as e:
            errors.append('radarr: ' + str(e)[:120])
            movies = []
        for m in movies:
            for field, kind in (('inCinemas', 'cinema'), ('digitalRelease', 'digital'), ('physicalRelease', 'physical')):
                d = (m.get(field) or '')[:10]
                if not d or not (start <= d <= end):
                    continue
                events.append({
                    'id': f'radarr:{m.get("id")}:{kind}',
                    'kind': kind,
                    'date': d,
                    'at': None,
                    'title': m.get('title'),
                    'subtitle': str(m.get('year') or ''),
                    'hasFile': bool(m.get('hasFile')),
                    'monitored': bool(m.get('monitored')),
                    'poster': _thumb(_poster(m.get('images'))),
                    'tmdbId': m.get('tmdbId'),
                    'tvdbId': None,
                    '_ids': _ids(m),
                })
    events.sort(key=lambda x: (x['date'], x['at'] or '', x['title'] or ''))
    if token:
        events = attach_library(token, events, errors)
    else:
        events = [{k: v for k, v in x.items() if k != '_ids'} for x in events]
    data = {'events': events, 'errors': errors, 'start': start, 'end': end, 'at': int(now)}
    with _cal_lock:
        if len(_cal) > 32:
            _cal.clear()
        _cal[key] = (now + 60, data)
    return data


def demo_calendar(token, start, end):
    """?demo=1: a fixed spread of sample events around today (UI testing when the real calendar is empty)."""
    today = dt.date.today()
    tmdb = 'https://image.tmdb.org/t/p/w342'

    def day(n):
        return (today + dt.timedelta(days=n)).isoformat()

    def at(n, hh, mm):
        local = dt.datetime.combine(today + dt.timedelta(days=n), dt.time(hh, mm)).astimezone()
        return local.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    ev = [
        {'id': 'demo:e1', 'kind': 'episode', 'date': day(-3), 'at': at(-3, 3, 0), 'title': 'Severance', 'subtitle': 'S02E03 · Who Is Alive?',
         'hasFile': True, 'monitored': True, 'poster': tmdb + '/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg', 'count': 1},
        {'id': 'demo:m1', 'kind': 'digital', 'date': day(-1), 'at': None, 'title': 'Hope', 'subtitle': '2026', 'hasFile': False, 'monitored': True,
         'poster': tmdb + '/1n37BJchWHLiSYQkuFxe5KjB951.jpg'},
        {'id': 'demo:e2', 'kind': 'episode', 'date': day(0), 'at': at(0, 21, 0), 'title': 'Reacher', 'subtitle': 'S01E02 · First Dance',
         'hasFile': False, 'monitored': True, 'poster': None, 'tmdbId': 108978, '_ids': {'tmdb': 108978}, 'seasonNumber': 1, 'count': 1},
        {'id': 'demo:e3', 'kind': 'episode', 'date': day(1), 'at': at(1, 9, 0), 'title': 'Carrie', 'subtitle': 'S01E01–E08 · 8 episodes',
         'hasFile': False, 'monitored': True, 'poster': None, 'count': 8},
        {'id': 'demo:m2', 'kind': 'cinema', 'date': day(4), 'at': None, 'title': 'Practical Magic 2', 'subtitle': '2026', 'hasFile': False,
         'monitored': True, 'poster': tmdb + '/ogwQOLbCfncjvBhFb5l0OmQH8KC.jpg'},
        {'id': 'demo:m3', 'kind': 'physical', 'date': day(12), 'at': None, 'title': 'Hope', 'subtitle': '2026', 'hasFile': False, 'monitored': True,
         'poster': tmdb + '/1n37BJchWHLiSYQkuFxe5KjB951.jpg'},
    ]
    errs = []
    if token:
        ev = attach_library(token, ev, errs)
    return {'events': ev, 'errors': errs, 'start': start, 'end': end, 'at': int(time.time()), 'demo': True}


# ---------------- HTTP glue (called from server.py) ----------------
def handle(handler, method):
    """Returns True if the request was handled."""
    parts = urllib.parse.urlsplit(handler.path)
    path, query = parts.path, parts.query
    if not (path.startswith('/api/seerr/') or path in ('/api/downloads', '/api/calendar')):
        return False
    token = (handler.headers.get("X-Jellyfin-Token", ""), handler.headers.get("X-Jellyfin-User", ""))
    public = bool(getattr(handler, 'public', False))
    try:
        demo = 'demo=1' in query.split('&')
        if path in ('/api/downloads', '/api/calendar') and not demo and not downloads_configured():
            raise Upstream(503, 'sonarr/radarr not configured')
        if path.startswith('/api/seerr/'):
            require('seerr')
        if path == '/api/downloads' and method == 'GET':
            import access
            access.require_admin(token)  # server internals (queue, imports): Jellyfin administrators only
            res = demo_downloads(token) if demo else downloads(token)
        elif path == '/api/calendar' and method == 'GET':
            import access
            access.require_admin(token)  # same gate as /api/downloads
            q = urllib.parse.parse_qs(query)
            start, end = (q.get('start') or [''])[0], (q.get('end') or [''])[0]
            res = demo_calendar(token, start, end) if demo else calendar(token, start, end)
        else:
            sub = path[len('/api/seerr'):]
            if method == 'GET' and sub == '/me':
                res = whoami(*token)
            elif method == 'GET' and sub == '/myrequests':
                res = my_requests(token)
            elif method == 'GET' and sub == '/dates':
                whoami(*token)
                res = release_dates(query)
            elif method == 'GET' and sub == '/reqoptions':
                res = request_options(token, query)
            elif method == 'POST' and sub == '/request':
                n = int(handler.headers.get('Content-Length', 0) or 0)
                if n > 64 * 1024:
                    raise Upstream(413, 'body too large')
                res = create_request(token, json.loads(handler.rfile.read(n) or b'null'), public)
            elif method == 'DELETE' and re.fullmatch(r'/request/\d+', sub):
                res = delete_request(token, int(sub.rsplit('/', 1)[1]))
            elif method == 'GET':
                whoami(*token)
                res = scrub_users(seerr_get(sub, query))
            else:
                raise Upstream(405, 'method not allowed')
        code, body = 200, res
    except Upstream as e:
        code, body = (e.code if 400 <= e.code < 600 else 502), {'error': str(e) if e.code < 500 or not public else 'upstream error'}
    except Exception as e:  # noqa: BLE001
        code, body = 500, {'error': type(e).__name__}
    data = json.dumps(body).encode()
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)
    return True
