"""Server-side subtitle tools for JellyShell, backed by Bazarr (find / download / sync / delete).

Same rules as arr_proxy.py: the Bazarr and Jellyfin API keys (BAZARR_*, JELLYFIN_API_KEY via config.py) never reach
the browser, and every route requires a valid Jellyfin token (arr_proxy.whoami). Without both keys the routes answer
503. Managing subtitles also requires the Jellyfin
user to be an administrator or to have EnableSubtitleManagement in its policy.

Mapping a Jellyfin item to Bazarr:
  episode: Jellyfin series ProviderIds.Tvdb -> Sonarr series (tvdbId) -> sonarrSeriesId -> Bazarr /episodes?seriesid[]=
           -> the episode whose path equals the Jellyfin file path (fallback: season/episode numbers).
  movie:   Bazarr /movies -> the movie whose path equals the Jellyfin path (fallback: Radarr tmdbId/imdbId).
  (Assumes Jellyfin, Sonarr, Radarr and Bazarr see the media under the same path, e.g. /media.)

Routes (JSON):
  GET    /api/subs/item/<jfId>      current subtitles + file release info + whether the caller may manage
  GET    /api/subs/search/<jfId>    manual provider search (10-60 s), candidates sorted by score
  POST   /api/subs/download         {itemId, provider, subtitle, hi, forced, original_format} -> new file + JF refresh
  POST   /api/subs/sync             {itemId, streamIndex} -> ffsubsync the external subtitle to the audio + JF refresh
  DELETE /api/subs/<jfId>?index=N   delete an external subtitle, only one that JellyShell downloaded itself
  GET    /api/subs/series/<jfId>?lang=en   per-season count of episodes missing that language (+ running job)
  POST   /api/subs/series           {seriesId, season|null, language} -> background job (missing episodes only)
  GET    /api/subs/jobs[/<id>]      running job / one job's progress;  DELETE /api/subs/jobs/<id> = stop after this episode
"""
import json
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path

import arr_proxy
import config
from arr_proxy import Upstream, _req, whoami, KEYS, SONARR, RADARR, JF, require

BAZARR = config.BAZARR_URL + '/api' if config.BAZARR_URL else ''
LEDGER = config.DATA_DIR / 'subs_created.json'  # files downloaded through JellyShell
_lock = threading.Lock()

KEYS['bazarr'] = config.BAZARR_API_KEY  # registered so arr_proxy._req scrubs it from error text too
KEYS['jf'] = config.JELLYFIN_API_KEY


def configured():
    """Subtitle tools need Bazarr and the Jellyfin admin key (item paths, library refresh)."""
    c = config.configured()
    return c['bazarr'] and c['jellyfinApiKey']


def bz(path, method='GET', timeout=30):
    require('bazarr')
    return _req(BAZARR + path, method=method, headers={'X-API-KEY': KEYS['bazarr']}, timeout=timeout)


def jfa(path, method='GET', timeout=15):
    """Jellyfin with the server's API key (item lookup, refresh)."""
    if not KEYS.get('jf'):
        raise Upstream(503, 'JELLYFIN_API_KEY not configured')
    return _req(JF + path, method=method, headers={'X-Emby-Token': KEYS['jf']}, timeout=timeout)


def q(v):
    return urllib.parse.quote(str(v), safe='')


# ---------------- permissions ----------------
_perm = {}


def require_manager(token):
    me = whoami(*token)
    uid = me['jellyfinUserId']
    hit = _perm.get(uid)
    if not hit or hit[0] < time.time():
        u = jfa(f'/Users/{uid}')
        p = u.get('Policy') or {}
        # Subtitle tools write into the library (download/sync/delete), so they're for Jellyfin administrators;
        # searching without being able to download would be a dead end, so search follows the same rule.
        hit = (time.time() + 600, bool(p.get('IsAdministrator')))
        _perm[uid] = hit
    return me, hit[1]


# ---------------- item mapping ----------------
_series_cache = {'at': 0, 'sonarr': [], 'movies_at': 0, 'movies': []}


def _sonarr_series():
    require('sonarr')  # episodes map to Bazarr through Sonarr's series ids
    if time.time() - _series_cache['at'] > 600:
        _series_cache['sonarr'] = _req(f'{SONARR}/series', KEYS.get('sonarr'))
        _series_cache['at'] = time.time()
    return _series_cache['sonarr']


def _bazarr_movies():
    if time.time() - _series_cache['movies_at'] > 300:
        _series_cache['movies'] = bz('/movies?start=0&length=-1')['data']
        _series_cache['movies_at'] = time.time()
    return _series_cache['movies']


def _sonarr_for(series, path):
    """Jellyfin series item -> Sonarr series (tvdb, then imdb, then a file/folder path under its folder)."""
    pid = {k.lower(): v for k, v in (series.get('ProviderIds') or {}).items()}
    cands = _sonarr_series()
    s = next((x for x in cands if pid.get('tvdb') and str(x.get('tvdbId')) == str(pid['tvdb'])), None) \
        or next((x for x in cands if pid.get('imdb') and x.get('imdbId') == pid['imdb']), None) \
        or next((x for x in cands if (path or '').startswith((x.get('path') or '\0').rstrip('/') + '/')), None)
    if not s:
        raise Upstream(404, 'series not found in Sonarr')
    return s


def resolve(jf_id):
    """Jellyfin item id -> {'kind','id' (sonarrEpisodeId|radarrId),'seriesId','path','bazarr' (row),'jf' (item)}."""
    if not re.fullmatch(r'[0-9a-fA-F]{32}', jf_id or ''):
        raise Upstream(400, 'bad item id')
    found = jfa(f'/Items?Ids={jf_id}&Fields=Path,ProviderIds,MediaStreams,MediaSources').get('Items') or []
    if not found:
        raise Upstream(404, 'item not found')
    it = found[0]
    path = it.get('Path') or ''
    if it.get('Type') == 'Episode':
        series = jfa(f'/Items?Ids={it["SeriesId"]}&Fields=ProviderIds')['Items'][0]
        s = _sonarr_for(series, path)
        eps = bz(f'/episodes?seriesid[]={s["id"]}')['data']
        e = next((x for x in eps if x.get('path') == path), None) \
            or next((x for x in eps if x.get('season') == it.get('ParentIndexNumber') and x.get('episode') == it.get('IndexNumber')), None)
        if not e:
            raise Upstream(404, 'episode not found in Bazarr')
        return {'kind': 'episode', 'id': e['sonarrEpisodeId'], 'seriesId': e['sonarrSeriesId'], 'path': e['path'], 'bazarr': e, 'jf': it}
    if it.get('Type') == 'Movie':
        movies = _bazarr_movies()
        m = next((x for x in movies if x.get('path') == path), None)
        if not m and RADARR:
            pid = {k.lower(): v for k, v in (it.get('ProviderIds') or {}).items()}
            r = _req(f'{RADARR}/movie', KEYS.get('radarr'))
            rm = next((x for x in r if pid.get('tmdb') and str(x.get('tmdbId')) == str(pid['tmdb'])), None) \
                or next((x for x in r if pid.get('imdb') and x.get('imdbId') == pid['imdb']), None)
            m = next((x for x in movies if rm and x.get('radarrId') == rm['id']), None)
        if not m:
            raise Upstream(404, 'movie not found in Bazarr')
        fresh = bz(f'/movies?radarrid[]={m["radarrId"]}')['data']
        m = fresh[0] if fresh else m
        return {'kind': 'movie', 'id': m['radarrId'], 'seriesId': None, 'path': m['path'], 'bazarr': m, 'jf': it}
    raise Upstream(400, 'only movies and episodes have subtitles')


def _refresh_row(ref):
    if ref['kind'] == 'episode':
        rows = bz(f'/episodes?episodeid[]={ref["id"]}')['data']
    else:
        rows = bz(f'/movies?radarrid[]={ref["id"]}')['data']
    return rows[0] if rows else ref['bazarr']


# ---------------- release parsing (for "matches your file") ----------------
SOURCES = [
    ('WEB-DL', r'web[ ._-]?dl'), ('WEBRip', r'web[ ._-]?rip'), ('WEB', r'\bweb\b'), ('BluRay', r'blu[ ._-]?ray|bdrip|brrip|bd[ ._-]?remux|\bremux\b'),
    ('HDTV', r'hdtv'), ('DVDRip', r'dvd[ ._-]?rip|\bdvd\b'),
]


def source_of(text):
    t = (text or '').lower()
    for name, rx in SOURCES:
        if re.search(rx, t):
            return 'WEB' if name in ('WEB-DL', 'WEBRip', 'WEB') else name
    return None


def release_of(path):
    """Release group / source / resolution of a video file name (scene style or Sonarr '(... Group)' style)."""
    stem = os.path.splitext(os.path.basename(path or ''))[0]
    group = None
    m = re.search(r'-([A-Za-z0-9]+)(?:\[[^\]]*\])?$', stem)
    if m and not re.fullmatch(r'\d+', m.group(1)):
        group = m.group(1)
    else:
        m = re.search(r'\(([^()]*)\)\s*$', stem)  # "(1080p BluRay x265 Garshasp)"
        if m:
            words = m.group(1).split()
            if words and not re.search(r'^(\d{3,4}p|x26[45]|h\.?26[45]|hevc|avc|bluray|web.*|hdtv|10bit)$', words[-1], re.I):
                group = words[-1]
    res = re.search(r'(2160|1080|720|576|480)p', stem, re.I)
    src = source_of(stem)
    exact = re.search(r'web[ ._-]?dl|web[ ._-]?rip|blu[ ._-]?ray|hdtv|dvd[ ._-]?rip', stem, re.I)
    return {'name': stem, 'group': group, 'source': src, 'sourceLabel': exact.group(0) if exact else src, 'resolution': res.group(0).lower() if res else None}


# ---------------- views ----------------
def _subs_view(ref, row):
    created = _ledger()
    jf_streams = [s for s in (ref['jf'].get('MediaStreams') or []) if s.get('Type') == 'Subtitle']
    by_path = {s.get('Path'): s.get('Index') for s in jf_streams if s.get('Path')}
    out = []
    for s in row.get('subtitles') or []:
        p = s.get('path')
        out.append({
            'language': s.get('code2'), 'code3': s.get('code3'), 'name': s.get('name'),
            'forced': bool(s.get('forced')), 'hi': bool(s.get('hi')),
            'external': bool(p), 'path': p, 'fileName': os.path.basename(p) if p else None,
            'jellyfinIndex': by_path.get(p), 'ours': bool(p and p in created),
            'cut': cut_check(ref, p) if p else None,
        })
    return out


def item_info(token, jf_id):
    me, can = require_manager(token)
    ref = resolve(jf_id)
    row = ref['bazarr']
    return {
        'kind': ref['kind'], 'canManage': can, 'file': {**release_of(ref['path']), **file_meta(ref)},
        'subtitles': _subs_view(ref, row),
        'missing': [m.get('code2') for m in row.get('missing_subtitles') or []],
    }


def search(token, jf_id):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    ref = resolve(jf_id)
    t0 = time.time()
    rel, current, out = _candidates(ref)
    return {'file': rel, 'current': current, 'candidates': out, 'seconds': round(time.time() - t0, 1)}


def _candidates(ref):
    """Bazarr manual search for one item -> (file release info, current external subs, candidates by score)."""
    if ref['kind'] == 'episode':
        data = bz(f'/providers/episodes?episodeid={ref["id"]}', timeout=180)
    else:
        data = bz(f'/providers/movies?radarrid={ref["id"]}', timeout=180)
    if isinstance(data, str):
        raise Upstream(502, data[:200])
    rel = {**release_of(ref['path']), **file_meta(ref)}
    current = [{'fileName': s['fileName'], 'cut': s['cut']} for s in _subs_view(ref, ref['bazarr']) if s['external']]
    # HI is ignored: providers often decide HI only after download, so any same-language external file may be overwritten.
    existing = {(s['language'], s['forced']) for s in _subs_view(ref, ref['bazarr']) if s['external']}
    out = []
    for c in data.get('data') or []:
        info = [ln.strip() for r in (c.get('release_info') or []) for ln in str(r).split('\n') if ln.strip()]
        text = ' '.join(info)
        matches = set(c.get('matches') or [])
        group_match = 'release_group' in matches or bool(rel['group'] and re.search(r'(?<![A-Za-z0-9])' + re.escape(rel['group']) + r'(?![A-Za-z0-9])', text, re.I))
        source_match = 'source' in matches and bool(rel['source']) and (source_of(text) in (None, rel['source']))
        hi = str(c.get('hearing_impaired')) == 'True'
        forced = str(c.get('forced')) == 'True'
        fps = re.search(r'(?<![\d.])(23\.976|23\.98|24\.0*|25\.0*|29\.97|30\.0*)\s*fps', text, re.I) \
            or re.search(r'\bfps[:= ]*(\d\d(?:\.\d+)?)', text, re.I)
        out.append({
            'provider': c.get('provider'), 'subtitle': c.get('subtitle'), 'language': c.get('language'),
            'hi': hi, 'forced': forced, 'originalFormat': str(c.get('original_format')) == 'True',
            'score': c.get('score'), 'releases': info[:6], 'uploader': c.get('uploader') or None,
            'fps': float(fps.group(1)) if fps else None,
            'matches': sorted(matches), 'dontMatches': sorted(c.get('dont_matches') or []),
            'groupMatch': group_match, 'sourceMatch': source_match,
            'replaces': (c.get('language'), forced) in existing,
        })
    out.sort(key=lambda x: (-(x['score'] or 0), not x['groupMatch'], not x['sourceMatch']))
    return rel, current, out


# ---------------- jobs / history helpers ----------------
def _max_job():
    jobs = bz('/system/jobs').get('data') or []
    return max([j['job_id'] for j in jobs] or [0])


def _wait_job(after_id, name_rx, timeout):
    """Wait for the Bazarr job created after `after_id` whose name matches; force-start it if it sits pending."""
    t_end = time.time() + timeout
    job, forced = None, False
    t0 = time.time()
    while time.time() < t_end:
        jobs = bz('/system/jobs').get('data') or []
        mine = [j for j in jobs if j['job_id'] > after_id and re.search(name_rx, j.get('job_name') or '', re.I)]
        if mine:
            job = min(mine, key=lambda j: j['job_id'])
            if job['status'] in ('completed', 'failed'):
                return job
            if job['status'] == 'pending' and not forced and time.time() - t0 > 3:
                bz(f'/system/jobs?id={job["job_id"]}&action=force_start', 'POST')
                forced = True
        time.sleep(1)
    return job


def _history(ref, length=5):
    if ref['kind'] == 'episode':
        return bz(f'/episodes/history?episodeid={ref["id"]}&start=0&length={length}')
    return bz(f'/movies/history?radarrid={ref["id"]}&start=0&length={length}')


def _jf_refresh(jf_id):
    jfa(f'/Items/{jf_id}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false', 'POST')


def _jf_refresh_and_find(jf_id, sub_path, timeout=40):
    """Ask Jellyfin to rescan the item, then wait until the external subtitle shows up. Returns its stream index."""
    jfa(f'/Items/{jf_id}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false', 'POST')
    t_end = time.time() + timeout
    while time.time() < t_end:
        time.sleep(1.5)
        it = (jfa(f'/Items?Ids={jf_id}&Fields=MediaStreams').get('Items') or [{}])[0]
        for s in it.get('MediaStreams') or []:
            if s.get('Type') == 'Subtitle' and s.get('Path') == sub_path:
                return s.get('Index')
    return None


# ---------------- host files: backups + cut check ----------------
# Bazarr/Jellyfin report paths as THEY see them (e.g. /media/tv/...); MEDIA_PATH_MAP turns them into paths this process
# can open ('<their-prefix>=<our-path>', default '/media=/media'). Unmapped paths simply skip backups/cut checks.


def host_path(container_path):
    """'/media/tv/...' (Bazarr/Jellyfin) -> local path via MEDIA_PATH_MAP, or None when no prefix matches."""
    if not isinstance(container_path, str) or '/../' in container_path:
        return None
    for src, dst in config.MEDIA_PATH_MAP:
        if container_path.startswith(src + '/'):
            return dst / container_path[len(src) + 1:]
    return None


def backup_sub(container_path):
    """Copy an existing subtitle to '<name>.jellyshell-bak' before Bazarr rewrites it. The first backup is kept
    (it holds the original); later syncs/downloads don't overwrite it. Returns the host backup path or None."""
    import shutil
    p = host_path(container_path)
    if not p or not p.is_file():
        return None
    bak = p.with_name(p.name + '.jellyshell-bak')
    if not bak.exists():
        shutil.copy2(p, bak)
        arr_proxy_log(f'subs_proxy: backed up {p.name} -> {bak.name}')
    return str(bak)


_TS = re.compile(r'(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})')


def sub_span(container_path):
    """(first cue start, last cue end) in seconds of an .srt/.vtt on disk, or None."""
    p = host_path(container_path)
    if not p or not p.is_file() or p.stat().st_size > 5_000_000:
        return None
    first = last = None
    for m in _TS.finditer(p.read_text(errors='replace')):
        g = [int(x) for x in m.groups()]
        a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        first = a if first is None else min(first, a)
        last = b if last is None else max(last, b)
    return (first, last) if last is not None else None


def cut_check(ref, container_path):
    """Compare the subtitle's last line with the video's length. A subtitle that keeps talking well past the end
    of the video was made for a longer cut (e.g. Arrested Development S4 original vs the 2018 remix)."""
    dur = (ref['jf'].get('RunTimeTicks') or 0) / 1e7
    span = sub_span(container_path)
    if not dur or not span:
        return None
    over = span[1] - dur
    return {'videoSeconds': round(dur), 'subtitleEndSeconds': round(span[1]), 'overrunSeconds': round(over),
            'likelyOtherCut': over > 45}


def file_meta(ref):
    it = ref['jf']
    v = next((s for s in it.get('MediaStreams') or [] if s.get('Type') == 'Video'), {})
    fps = v.get('RealFrameRate') or v.get('AverageFrameRate')
    return {'runtimeSeconds': round((it.get('RunTimeTicks') or 0) / 1e7) or None, 'fps': round(fps, 3) if fps else None}


def _ledger():
    try:
        return set(json.loads(LEDGER.read_text()))
    except Exception:  # noqa: BLE001
        return set()


def _ledger_set(paths):
    LEDGER.write_text(json.dumps(sorted(paths), indent=1))


# ---------------- actions ----------------
def download(token, body):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    if not isinstance(body, dict):
        raise Upstream(400, 'json body required')
    jf_id, provider, sub = body.get('itemId'), body.get('provider'), body.get('subtitle')
    if not (isinstance(provider, str) and re.fullmatch(r'[a-z0-9_.-]{2,40}', provider) and isinstance(sub, str) and 0 < len(sub) < 20000):
        raise Upstream(400, 'provider and subtitle required')
    with _lock:  # one download/sync at a time keeps job + history matching unambiguous
        ref = resolve(jf_id)
        return _do_download(ref, jf_id, provider, sub, body)


def _do_download(ref, jf_id, provider, sub, body, wait_jf=True, backup=True):
    """Download one provider candidate through Bazarr. Caller holds _lock. Raises Upstream when nothing arrived.
    backup=False only for callers that already proved no same-language file exists (series bulk download)."""
    tf = lambda k: 'True' if body.get(k) else 'False'  # noqa: E731
    # Bazarr paths are container paths (/media/...): compare as strings, never os.path on the host.
    before_files = {s.get('path') for s in ref['bazarr'].get('subtitles') or [] if s.get('path')}
    # Bazarr names files by language, so a download may overwrite one of these: back them all up first.
    backups = [b for b in (backup_sub(p) for p in sorted(before_files)) if b] if backup else []
    hist0 = _history(ref, 1)
    last0 = (hist0.get('data') or [{}])[0].get('parsed_timestamp'), hist0.get('total')
    j0 = _max_job()
    common = f'hi={tf("hi")}&forced={tf("forced")}&original_format={tf("original_format")}&provider={q(provider)}&subtitle={q(sub)}'
    if ref['kind'] == 'episode':
        bz(f'/providers/episodes?seriesid={ref["seriesId"]}&episodeid={ref["id"]}&{common}', 'POST')
    else:
        bz(f'/providers/movies?radarrid={ref["id"]}&{common}', 'POST')
    job = _wait_job(j0, r'manually download', 120)
    if not job or job['status'] not in ('completed', 'failed'):
        raise Upstream(504, 'Bazarr is still downloading; try again in a minute')
    hist = _history(ref, 3)
    new = [h for h in hist.get('data') or [] if h.get('action') in (2, 1, 4)]
    newest = new[0] if new else None
    if not newest or hist.get('total') == last0[1] or not newest.get('subtitles_path'):
        raise Upstream(502, 'the provider returned no subtitle (download failed)')
    path = newest['subtitles_path']
    existed = path in before_files
    if not existed:
        led = _ledger()
        led.add(path)
        _ledger_set(led)
    if wait_jf:
        idx = _jf_refresh_and_find(jf_id, path)
    else:
        idx = None
        _jf_refresh(jf_id)
    return {'path': path, 'fileName': os.path.basename(path), 'replacedExisting': existed, 'backups': backups,
            'cut': cut_check(ref, path),
            'jellyfinIndex': idx, 'description': newest.get('description'), 'provider': newest.get('provider')}


def sync(token, body):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    if not isinstance(body, dict) or not isinstance(body.get('streamIndex'), int):
        raise Upstream(400, 'itemId and integer streamIndex required')
    with _lock:
        ref = resolve(body.get('itemId'))
        st = next((s for s in ref['jf'].get('MediaStreams') or [] if s.get('Type') == 'Subtitle' and s.get('Index') == body['streamIndex']), None)
        if not st or not st.get('IsExternal') or not st.get('Path'):
            raise Upstream(400, 'only external subtitle files can be re-timed')
        bsub = next((s for s in ref['bazarr'].get('subtitles') or [] if s.get('path') == st['Path']), None)
        if not bsub:
            raise Upstream(404, 'Bazarr does not know this subtitle file')
        backup = backup_sub(st['Path'])
        hist0 = _history(ref, 1).get('total')
        j0 = _max_job()
        # Always sync against the AUDIO (never an embedded subtitle track): a:N = the Nth audio stream of the file.
        aud = body.get('audioOrdinal')
        aud = aud if isinstance(aud, int) and 0 <= aud <= 9 else 0
        args = (f'action=sync&language={q(bsub.get("code2"))}&path={q(st["Path"])}&type={ref["kind"]}&id={ref["id"]}'
                f'&forced={"True" if bsub.get("forced") else "False"}&hi={"True" if bsub.get("hi") else "False"}'
                f'&reference={q("a:%d" % aud)}')
        bz('/subtitles?' + args, 'PATCH')
        job = _wait_job(j0, r'^Sync(ing|ed) /', 240)
        if not job or job['status'] not in ('completed', 'failed'):
            raise Upstream(504, 'sync is still running in Bazarr; check again in a minute')
        hist = _history(ref, 2)
        h = (hist.get('data') or [{}])[0]
        if hist.get('total') == hist0 or h.get('action') != 5:
            raise Upstream(502, 'sync failed (Bazarr could not align this subtitle)')
        m = re.search(r'offset of (-?\d+(?:\.\d+)?) seconds and a framerate scale factor of (\d+(?:\.\d+)?)', h.get('description') or '')
        jfa(f'/Items/{ref["jf"]["Id"]}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false', 'POST')
        return {'path': st['Path'], 'fileName': os.path.basename(st['Path']), 'jellyfinIndex': st.get('Index'),
                'offsetSeconds': float(m.group(1)) if m else None, 'framerateScale': float(m.group(2)) if m else None,
                'description': h.get('description'), 'reference': f'a:{aud}', 'backup': backup,
                'cut': cut_check(ref, st['Path'])}


def delete(token, jf_id, index):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    with _lock:
        ref = resolve(jf_id)
        st = next((s for s in ref['jf'].get('MediaStreams') or [] if s.get('Type') == 'Subtitle' and s.get('Index') == index), None)
        led = _ledger()
        if not st or not st.get('Path') or st['Path'] not in led:
            raise Upstream(403, 'only subtitles downloaded from JellyShell can be deleted here')
        bsub = next((s for s in ref['bazarr'].get('subtitles') or [] if s.get('path') == st['Path']), None)
        if not bsub:
            raise Upstream(404, 'Bazarr does not know this subtitle file')
        args = (f'language={q(bsub.get("code2"))}&forced={"True" if bsub.get("forced") else "False"}'
                f'&hi={"True" if bsub.get("hi") else "False"}&path={q(st["Path"])}')
        if ref['kind'] == 'episode':
            bz(f'/episodes/subtitles?seriesid={ref["seriesId"]}&episodeid={ref["id"]}&{args}', 'DELETE')
        else:
            bz(f'/movies/subtitles?radarrid={ref["id"]}&{args}', 'DELETE')
        led.discard(st['Path'])
        _ledger_set(led)
        jfa(f'/Items/{jf_id}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false', 'POST')
        return {'deleted': os.path.basename(st['Path'])}


# ---------------- series / season bulk download ----------------
# Bazarr's own bulk action (PATCH /api/series action=search-missing) is NOT used: it runs Bazarr's automatic search,
# which only accepts results >= general.minimum_score (90 % for episodes here), can't be limited to one season and only
# searches the series' profile languages. Providers typically top out at ~86 % for shows like 30 Rock, so it downloads
# nothing (that's why those shows have no subs at all). Instead each missing episode gets the same manual search the
# finder uses, and the best sane candidate is downloaded, one episode at a time, in a background thread.
_jobs = {}  # id -> job dict (in memory; a page-server restart forgets them)
_jobs_lock = threading.Lock()
SUB_EXT = ('.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup', '.smi')


def _jf_series(series_jf_id):
    if not re.fullmatch(r'[0-9a-fA-F]{32}', series_jf_id or ''):
        raise Upstream(400, 'bad series id')
    found = jfa(f'/Items?Ids={series_jf_id}&Fields=Path,ProviderIds').get('Items') or []
    if not found or found[0].get('Type') != 'Series':
        raise Upstream(404, 'series not found')
    return found[0]


def _series_episodes(series):
    """(sonarr series, [(bazarr episode row, jellyfin episode item or None)]) sorted by season/episode."""
    s = _sonarr_for(series, (series.get('Path') or '') + '/')
    rows = bz(f'/episodes?seriesid[]={s["id"]}')['data']
    jf = jfa(f'/Items?ParentId={series["Id"]}&Recursive=true&IncludeItemTypes=Episode&Fields=Path,MediaStreams').get('Items') or []
    by_path = {i.get('Path'): i for i in jf if i.get('Path')}
    by_num = {(i.get('ParentIndexNumber'), i.get('IndexNumber')): i for i in jf}
    out = [(r, by_path.get(r.get('path')) or by_num.get((r.get('season'), r.get('episode')))) for r in rows if r.get('path')]
    out.sort(key=lambda x: (x[0].get('season') or 0, x[0].get('episode') or 0))
    return s, out


def _profile_langs(bz_series):
    """Languages of the series' Bazarr language profile: [{'code2','code3','name'}] (manual search only returns these)."""
    pid = bz_series.get('profileId')
    if pid is None:
        return []
    prof = next((p for p in bz('/system/languages/profiles') if p.get('profileId') == pid), None)
    if not prof:
        return []
    names = {lang['code3']: lang for lang in bz('/system/languages')}
    out = []
    for item in prof.get('items') or []:
        if str(item.get('forced')) == 'True':
            continue
        lang = names.get(item.get('language')) or {}
        if lang.get('code2') and all(o['code2'] != lang['code2'] for o in out):
            out.append({'code2': lang['code2'], 'code3': lang.get('code3'), 'name': lang.get('name')})
    return out


def _disk_subs(container_video, lang):
    """Subtitle files on disk next to the video that Bazarr could clash with: '<stem>.<lang>[.*].<ext>' for the
    2- or 3-letter code, plus a bare '<stem>.<ext>' (unknown language). Catches files Bazarr hasn't indexed yet."""
    p = host_path(container_video)
    if not p or not p.parent.is_dir():
        return []
    stem = p.stem
    codes = {lang, LANG2TO3.get(lang, lang)}
    hits = []
    for f in p.parent.iterdir():
        n = f.name
        if not n.startswith(stem + '.') or not n.lower().endswith(SUB_EXT):
            continue
        rest = n[len(stem) + 1:].lower().split('.')
        if len(rest) == 1 or rest[0] in codes:
            hits.append(n)
    return hits


LANG2TO3 = {'en': 'eng', 'uk': 'ukr', 'ru': 'rus', 'cs': 'ces', 'de': 'deu', 'fr': 'fra', 'es': 'spa', 'it': 'ita', 'pl': 'pol', 'ja': 'jpn', 'ko': 'kor', 'hu': 'hun'}


def _has_lang(row, lang):
    """True when Bazarr knows a full (non-forced) subtitle in `lang`, embedded or external."""
    return any(s.get('code2') == lang and not s.get('forced') for s in row.get('subtitles') or [])


def _ep_label(row):
    return f'S{row.get("season") or 0:02d}E{row.get("episode") or 0:02d}'


def series_plan(token, series_jf_id, lang):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    series = _jf_series(series_jf_id)
    s, eps = _series_episodes(series)
    bzs = (bz(f'/series?seriesid[]={s["id"]}').get('data') or [{}])[0]
    langs = _profile_langs(bzs)
    lang = lang if any(x['code2'] == lang for x in langs) else (langs[0]['code2'] if langs else lang)
    seasons = {}
    for row, jf in eps:
        n = row.get('season') or 0
        x = seasons.setdefault(n, {'season': n, 'jellyfinId': (jf or {}).get('SeasonId'), 'episodes': 0, 'missing': 0})
        x['episodes'] += 1
        x['jellyfinId'] = x['jellyfinId'] or (jf or {}).get('SeasonId')
        if not _has_lang(row, lang):
            x['missing'] += 1
    return {'language': lang, 'languages': langs, 'seasons': sorted(seasons.values(), key=lambda x: x['season']),
            'episodes': len(eps), 'missing': sum(x['missing'] for x in seasons.values()), 'job': _active_job(series_jf_id)}


def _public_job(j):
    return {k: v for k, v in j.items() if not k.startswith('_')}


def _active_job(series_jf_id=None):
    with _jobs_lock:
        for j in _jobs.values():
            if j['state'] in ('queued', 'running') and (series_jf_id is None or j['seriesId'] == series_jf_id):
                return _public_job(j)
    return None


def start_series(token, body):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    if not isinstance(body, dict):
        raise Upstream(400, 'json body required')
    lang = body.get('language')
    if not (isinstance(lang, str) and re.fullmatch(r'[a-z]{2}', lang)):
        raise Upstream(400, 'language (2-letter code) required')
    season = body.get('season')
    if season is not None and not (isinstance(season, int) and 0 <= season < 1000):
        raise Upstream(400, 'season must be a number')
    series = _jf_series(body.get('seriesId'))
    s, eps = _series_episodes(series)
    bzs = (bz(f'/series?seriesid[]={s["id"]}').get('data') or [{}])[0]
    langs = _profile_langs(bzs)
    if not any(x['code2'] == lang for x in langs):
        have = ', '.join(x['name'] for x in langs) or 'none'
        raise Upstream(400, f'Bazarr only searches this show for: {have}. Add the language to its Bazarr profile first.')
    todo = [(r, jf) for r, jf in eps if (season is None or r.get('season') == season) and not _has_lang(r, lang)]
    with _jobs_lock:
        if any(j['state'] in ('queued', 'running') for j in _jobs.values()):
            raise Upstream(409, 'a subtitle download is already running; wait for it to finish')
        jid = f'{int(time.time())}-{len(_jobs) + 1}'
        name = next((x['name'] for x in langs if x['code2'] == lang), lang)
        job = {'id': jid, 'seriesId': series['Id'], 'seriesName': series.get('Name'), 'season': season, 'language': lang,
               'languageName': name, 'state': 'running', 'total': len(todo), 'done': 0, 'current': None,
               'created': [], 'skipped': [], 'failed': [], 'startedAt': time.time(), 'finishedAt': None, 'cancel': False,
               '_todo': todo}
        _jobs[jid] = job
        for old in sorted(_jobs)[:-20]:  # keep the last 20
            if _jobs[old]['state'] not in ('queued', 'running'):
                del _jobs[old]
    arr_proxy_log(f'subs_proxy: series job {jid} {series.get("Name")} season={season} lang={lang} episodes={len(todo)}')
    threading.Thread(target=_run_series_job, args=(job,), daemon=True, name='subs-series-' + jid).start()
    return _public_job(job)


def _pick(cands, lang):
    """Best candidate that is really this episode in this language (sorted by score already)."""
    ok = [c for c in cands if c['language'] == lang and not c['forced']
          and {'series', 'season', 'episode'} <= set(c['matches'])]
    return ok[:3]


def _run_series_job(job):
    lang = job['language']
    for row0, jf in job.pop('_todo'):
        if job['cancel']:
            break
        label = _ep_label(row0)
        job['current'] = f'{label} {row0.get("title") or ""}'.strip()
        try:
            row = (bz(f'/episodes?episodeid[]={row0["sonarrEpisodeId"]}').get('data') or [row0])[0]
            on_disk = _disk_subs(row['path'], lang)
            if _has_lang(row, lang) or on_disk:
                job['skipped'].append({'episode': label, 'reason': 'already has subtitles', 'files': on_disk})
                continue
            if not jf:
                job['failed'].append({'episode': label, 'reason': 'not in Jellyfin'})
                continue
            ref = {'kind': 'episode', 'id': row['sonarrEpisodeId'], 'seriesId': row['sonarrSeriesId'], 'path': row['path'], 'bazarr': row, 'jf': jf}
            # Search outside _lock (it only reads; holding the lock would stall the finder for up to a minute).
            _rel, _cur, cands = _candidates(ref)
            picks = _pick(cands, lang)
            if not picks:
                job['failed'].append({'episode': label, 'reason': 'no subtitles found'})
                continue
            got, last_err = None, None
            for c in picks:
                if job['cancel']:
                    break
                with _lock:
                    # Re-check right before writing: a file in this language may have appeared meanwhile.
                    row = (bz(f'/episodes?episodeid[]={row["sonarrEpisodeId"]}').get('data') or [row])[0]
                    if _has_lang(row, lang) or _disk_subs(row['path'], lang):
                        last_err = 'already has subtitles'
                        break
                    ref['bazarr'] = row
                    try:
                        got = _do_download(ref, jf['Id'], c['provider'], c['subtitle'],
                                           {'hi': c['hi'], 'forced': c['forced'], 'original_format': c['originalFormat']},
                                           wait_jf=False, backup=False)
                        break
                    except Upstream as e:
                        last_err = str(e)
            if got:
                job['created'].append({'episode': label, 'fileName': got['fileName'], 'provider': got.get('provider'),
                                       'score': next((c['score'] for c in picks if c['provider'] == got.get('provider')), None),
                                       'otherCut': bool((got.get('cut') or {}).get('likelyOtherCut'))})
            elif last_err == 'already has subtitles':
                job['skipped'].append({'episode': label, 'reason': last_err})
            else:
                job['failed'].append({'episode': label, 'reason': last_err or 'download failed'})
        except Exception as e:  # noqa: BLE001
            job['failed'].append({'episode': label, 'reason': str(e)[:200] if isinstance(e, Upstream) else type(e).__name__})
            arr_proxy_log(f'subs_proxy: series job {job["id"]} {label}: {type(e).__name__}: {e}')
        finally:
            job['done'] += 1
    job['current'] = None
    job['state'] = 'cancelled' if job['cancel'] else 'done'
    job['finishedAt'] = time.time()
    arr_proxy_log(f'subs_proxy: series job {job["id"]} {job["state"]}: created={len(job["created"])} '
                  f'skipped={len(job["skipped"])} failed={len(job["failed"])}')


def get_job(token, jid):
    me, can = require_manager(token)
    if not can:
        raise Upstream(403, 'subtitle management is not allowed for this user')
    with _jobs_lock:
        j = _jobs.get(jid)
        if not j:
            raise Upstream(404, 'no such job')
        return _public_job(j)


def cancel_job(token, jid):
    get_job(token, jid)
    _jobs[jid]['cancel'] = True  # stops after the current episode
    return _public_job(_jobs[jid])


# ---------------- HTTP glue ----------------
def handle(handler, method):
    parts = urllib.parse.urlsplit(handler.path)
    path, query = parts.path, parts.query
    if not path.startswith('/api/subs/'):
        return False
    token = (handler.headers.get('X-Jellyfin-Token', ''), handler.headers.get('X-Jellyfin-User', ''))
    sub = path[len('/api/subs'):]

    def body():
        n = int(handler.headers.get('Content-Length', 0) or 0)
        return json.loads(handler.rfile.read(n) or b'null')

    public = bool(getattr(handler, 'public', False))
    try:
        if not configured():
            raise Upstream(503, 'subtitle tools not configured (BAZARR_URL/BAZARR_API_KEY and JELLYFIN_API_KEY)')
        if public:
            # Internet callers: the whole subtitle toolset (incl. item info, which exposes file paths) is for
            # subtitle managers only.
            me, can = require_manager(token)
            if not can:
                raise Upstream(403, 'subtitle tools are not enabled for your account')
            n = int(handler.headers.get('Content-Length', 0) or 0)
            if n > 64 * 1024:
                raise Upstream(413, 'body too large')
        if method != 'GET':
            # Download / sync / delete write into the library: Jellyfin administrators only (LAN and public).
            import access
            access.require_admin(token)
        if method == 'GET' and re.fullmatch(r'/item/[0-9a-f]{32}', sub):
            res = item_info(token, sub.rsplit('/', 1)[1])
        elif method == 'GET' and re.fullmatch(r'/search/[0-9a-f]{32}', sub):
            res = search(token, sub.rsplit('/', 1)[1])
        elif method == 'POST' and sub == '/download':
            res = download(token, body())
        elif method == 'POST' and sub == '/sync':
            res = sync(token, body())
        elif method == 'DELETE' and re.fullmatch(r'/[0-9a-f]{32}', sub):
            qs = urllib.parse.parse_qs(query)
            res = delete(token, sub[1:], int((qs.get('index') or ['-1'])[0]))
        elif method == 'GET' and re.fullmatch(r'/series/[0-9a-f]{32}', sub):
            qs = urllib.parse.parse_qs(query)
            res = series_plan(token, sub.rsplit('/', 1)[1], (qs.get('lang') or ['en'])[0][:3])
        elif method == 'POST' and sub == '/series':
            res = start_series(token, body())
        elif method == 'GET' and sub == '/jobs':
            me, can = require_manager(token)
            res = {'job': _active_job() if can else None}
        elif method == 'GET' and re.fullmatch(r'/jobs/\d+-\d+', sub):
            res = get_job(token, sub.rsplit('/', 1)[1])
        elif method == 'DELETE' and re.fullmatch(r'/jobs/\d+-\d+', sub):
            res = cancel_job(token, sub.rsplit('/', 1)[1])
        else:
            raise Upstream(405, 'not allowed')
        code, out = 200, res
    except Upstream as e:
        code, out = (e.code if 400 <= e.code < 600 else 502), {'error': str(e) if e.code < 500 or not public else 'upstream error'}
    except Exception as e:  # noqa: BLE001
        code, out = 500, {'error': type(e).__name__}
        arr_proxy_log(f'subs_proxy {method} {sub}: {type(e).__name__}: {e}')
    data = json.dumps(out).encode()
    try:
        handler.send_response(code)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
    except (BrokenPipeError, ConnectionResetError):
        pass  # client cancelled (B during a search)
    return True


def arr_proxy_log(msg):
    for k in KEYS.values():
        if k:
            msg = msg.replace(k, '<key>')
    print(msg, flush=True)
