""""From the same world": titles that belong to the same franchise as a TMDB movie/show, across movie <-> TV.

GET /api/seerr/franchise?type=movie|tv&id=<tmdb>  (via arr_proxy.handle, Seerr only, 6 h cache)
  -> {"results": [SItem...]}  collection parts in release order, then spin-offs most-voted first; never the title itself.

Sources (precision over recall: a wrong "same world" card is worse than a missing one):
  1. TMDB collection parts (movies), via Seerr /collection/{id}.
  2. Cross-type spin-offs: Seerr /search for the base title ("Monsters vs. Aliens: Supersonic Joyride" ->
     "monsters vs aliens"); a hit must (a) have a normalized title equal to the base or starting with it as whole
     words, and (b) share real evidence with the source: a production company / network after stripping generic
     words ("DreamWorks Animation" == "DreamWorks Animation Television"), or 2+ top-billed cast, or a creator.
     A company match only on a mega-studio/broadcaster (Warner, Universal, Disney, Netflix, BBC...) also needs a
     shared specific keyword or person: those make many unrelated titles with the same short name.
  3. Differently-titled spin-offs from TMDB recommendations (Breaking Bad <-> Better Call Saul): spin-off/prequel
     keyword on either side AND a shared show creator / source novelist.
Placeholders without a poster and user-made duplicates (no date, no studio) are dropped.
"""
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import arr_proxy as A

TTL = 6 * 3600
_cache = {}  # (type, id) -> (expires, results)
_details = {}  # (type, id) -> (expires, detail)
_lock = threading.Lock()

# News / reality / talk TV, documentaries (making-ofs, featurettes) and music (concerts) share a title but aren't the
# same story world. Skipped unless the source title is one itself.
NOISE_GENRES = {10763, 10764, 10767, 99, 10402}
MAX_RESULTS = 20

# Words that say what kind of company it is, not which one.
_CO_GENERIC = set('''pictures picture television tv studios studio animation animated productions production prods films film
entertainment inc llc ltd limited co company corporation corp group media international the presents distribution features
feature home video network networks channel classics releasing entertainments original originals'''.split())
# Studios/broadcasters that make so many titles that a shared name + shared studio proves nothing on its own.
_MEGA = {'warner bros', 'warner', 'universal', 'columbia', 'paramount', '20th century', '20th century fox', 'twentieth century fox',
         'fox', 'walt disney', 'disney', 'netflix', 'amazon', 'amazon mgm', 'hbo', 'bbc', 'sony', 'metro goldwyn mayer', 'mgm',
         'lionsgate', 'lions gate', 'canal', 'canal+', 'studiocanal', 'new line', 'apple', 'itv', 'channel 4', 'nbc', 'cbs', 'abc',
         'relativity', 'miramax', 'touchstone', 'tristar', 'screen gems', 'focus', 'summit', 'bbc one', 'bbc two', 'showtime',
         'starz', 'fx', 'amc', 'peacock', 'hulu', 'max', 'sky', 'tf1', 'ard', 'zdf', 'rai', 'nhk', 'tencent', 'iqiyi', 'youku',
         'toho', 'toei', 'cj', 'cj entertainment', 'showbox', 'eros', 't series', 'zee', 'dharma'}
# Keywords too common to tie two titles together.
_KW_GENERIC = {
    'sequel', 'prequel', 'remake', 'reboot', 'spin off', 'spinoff', 'based on novel or book', 'based on comic', 'based on comic book',
    'based on true story', 'based on video game', 'duringcreditsstinger', 'aftercreditsstinger', 'woman director', '3d', '3d animation',
    'animation', 'anime', 'cartoon', 'live action and animation', 'christmas', 'halloween', 'friendship', 'family', 'love', 'new york city',
    'london, england', 'murder', 'revenge', 'superhero', 'dystopia', 'future', 'alien', 'monster', 'sitcom', 'miniseries', 'biography',
    'short film', 'adult animation', 'comedy', 'drama', 'police', 'detective', 'high school', 'teenager', 'magic', 'kids', 'children',
}
_NUM_WORDS = r'(?:part|chapter|volume|vol|episode|book)\s+(?:\w+)'
_ROMAN = r'(?:ii|iii|iv|v|vi|vii|viii|ix|x)'


def norm_title(s):
    s = (s or '').lower().replace('&', ' and ').replace('’', "'")
    s = re.sub(r"[.'`]", '', s)  # "vs." -> "vs", "B.O.B." -> "bob"
    s = re.sub(r'[^\w]+', ' ', s).strip()
    return re.sub(r'^the\s+', '', s)


def base_titles(title, collection=None):
    """Franchise names to search for: the title without subtitle / part numbers / year, plus the collection name."""
    out = []

    def add(t):
        t = re.sub(r'\s*\((?:19|20)\d\d\)\s*$', '', t or '')
        t = re.split(r'\s*(?::| - | – | — )\s*', t, maxsplit=1)[0]
        n = norm_title(t)
        n = re.sub(rf'\s+(?:{_NUM_WORDS}|{_ROMAN}|\d+)$', '', n).strip()
        if n and n not in out:
            out.append(n)

    add(title)
    if collection:
        add(re.sub(r'\s*(?:collection|saga|trilogy|series|franchise)\s*$', '', collection, flags=re.I))
    return out


def title_matches(title, base):
    n = norm_title(title)
    return n == base or n.startswith(base + ' ')


def title_contains(title, base):
    """The franchise name anywhere in the title as whole words; only for distinctive names (2+ words or 7+ letters)."""
    if ' ' not in base and len(base) < 7:
        return False
    return f' {base} ' in f' {norm_title(title)} '


def _co_key(name):
    words = [w for w in norm_title(name).split() if w not in _CO_GENERIC]
    return ' '.join(words)


def companies(d):
    keys = set()
    for c in (d.get('productionCompanies') or []) + (d.get('networks') or []):
        k = _co_key(c.get('name'))
        if k:
            keys.add(k)
    return keys


def _is_mega(k):
    return k in _MEGA or any(k.startswith(m + ' ') for m in _MEGA)


def people(d):
    cast = [c['id'] for c in ((d.get('credits') or {}).get('cast') or [])[:10]]
    creators = {c['id'] for c in d.get('createdBy') or []}
    crew = {c['id'] for c in ((d.get('credits') or {}).get('crew') or []) if c.get('job') in ('Director', 'Creator', 'Novel', 'Characters')}
    return set(cast), creators | crew


# Source authors for spin-off detection. NOT 'Characters' (Stan Lee / Jack Kirby are on every Marvel title), NOT
# 'Executive Producer' (the same EPs run unrelated shows: Reacher -> Cross), NOT 'Original Story' (John Lasseter
# links Cars to Toy Story 2) and NOT shared cast (every MCU film shares 2+ Avengers).
_AUTHOR_JOBS = ('Novel', 'Author', 'Book', 'Creator')
# Not 'sequel': it's on half of all films and pairs Cars with Toy Story 2 the moment a creator matches.
_SPIN_KW = {'spin off', 'spinoff', 'prequel', 'based on tv series', 'based on movie', 'continuation'}


def authors(d):
    s = {c['id'] for c in d.get('createdBy') or []}
    s |= {c['id'] for c in ((d.get('credits') or {}).get('crew') or []) if c.get('job') in _AUTHOR_JOBS}
    return s


def spinoff_evidence(src, cand):
    """Differently-titled spin-offs (Breaking Bad <-> Better Call Saul, Game of Thrones -> House of the Dragon):
    a spin-off/prequel keyword on either side AND a shared show creator or source novelist."""
    kw = {k['name'].lower() for k in (src.get('keywords') or []) + (cand.get('keywords') or []) if k.get('name')}
    if kw & _SPIN_KW and authors(src) & authors(cand):
        return 'spinoff:creator'
    return None


def keywords(d):
    return {k['name'].lower() for k in d.get('keywords') or [] if k.get('name') and k['name'].lower() not in _KW_GENERIC}


def evidence(src, cand):
    """Why `cand` belongs to `src`'s world, or None."""
    sc, cc = companies(src), companies(cand)
    shared = sc & cc
    scast, sstaff = people(src)
    ccast, cstaff = people(cand)
    cast = scast & ccast
    staff = sstaff & cstaff
    kw = keywords(src) & keywords(cand)
    specific = {k for k in shared if not _is_mega(k)}
    if specific:
        return 'company:' + sorted(specific)[0]
    if len(cast) >= 2 or staff:
        return 'people'
    if shared and (kw or cast):
        return 'company+' + ('kw' if kw else 'cast')
    return None


def detail(kind, tmdb_id):
    k = (kind, int(tmdb_id))
    now = time.time()
    with _lock:
        hit = _details.get(k)
        if hit and hit[0] > now:
            return hit[1]
    d = A.seerr(f'/{kind}/{tmdb_id}')
    with _lock:
        if len(_details) > 3000:
            _details.clear()
        _details[k] = (now + TTL, d)
    return d


def _slim(x, kind, why):
    mi = x.get('mediaInfo') or {}
    return {
        'id': x['id'], 'mediaType': kind, 'title': x.get('title'), 'name': x.get('name'),
        'posterPath': x.get('posterPath'), 'backdropPath': x.get('backdropPath'),
        'releaseDate': x.get('releaseDate'), 'firstAirDate': x.get('firstAirDate'),
        'mediaInfo': {'status': mi.get('status'), 'jellyfinMediaId': mi.get('jellyfinMediaId')} if mi else None,
        'why': why, 'date': x.get('releaseDate') or x.get('firstAirDate') or '9999', 'votes': x.get('voteCount') or 0,
    }


def _search(base, pages=2):
    out = []
    for p in range(1, pages + 1):
        try:
            r = A.seerr(f'/search?query={urllib.parse.quote(base)}&page={p}')
        except A.Upstream:
            break
        out += r.get('results') or []
        if p >= (r.get('totalPages') or 1):
            break
    return out


def compute(kind, tmdb_id, trace=None):
    src = detail(kind, tmdb_id)
    title = src.get('title') or src.get('name') or ''
    coll = src.get('collection') or src.get('belongsToCollection')
    found = {}  # (kind, id) -> item

    if coll and coll.get('id'):
        try:
            c = A.seerr(f"/collection/{coll['id']}")
            for p in c.get('parts') or []:
                if p.get('posterPath'):  # "Untitled Saw Film" placeholders
                    found[('movie', p['id'])] = _slim(p, 'movie', 'collection')
        except A.Upstream:
            pass

    bases = base_titles(title, coll and coll.get('name'))
    orig = src.get('originalTitle') or src.get('originalName')
    if orig and orig != title and src.get('originalLanguage') == 'en':
        bases += [b for b in base_titles(orig) if b not in bases]
    src_genres = {g.get('id') for g in src.get('genres') or []}
    cands = {}  # (kind, id) -> (search hit, loose)
    for base in bases:
        for x in _search(base):
            k = x.get('mediaType')
            if k not in ('movie', 'tv') or (k, x['id']) in found or (k, x['id']) == (kind, int(tmdb_id)):
                continue
            if x.get('adult') or (NOISE_GENRES - src_genres) & set(x.get('genreIds') or []):
                continue
            t = x.get('title') or x.get('name')
            if any(title_matches(t, b) for b in bases):
                cands[(k, x['id'])] = (x, False)
            elif (k, x['id']) not in cands and any(title_contains(t, b) for b in bases):
                cands[(k, x['id'])] = (x, True)  # "El Camino: A Breaking Bad Movie", "Jack Reacher"
    picks = list(cands.items())[:16]  # each needs a detail call; search order = TMDB relevance
    # Differently-titled spin-offs only show up in TMDB recommendations (Breaking Bad -> Better Call Saul).
    try:
        recs = A.seerr(f'/{kind}/{tmdb_id}/recommendations?page=1').get('results') or []
    except A.Upstream:
        recs = []
    rec_picks = []
    for x in recs:
        k = x.get('mediaType') or kind
        if k in ('movie', 'tv') and (k, x['id']) not in found and (k, x['id']) not in cands and not x.get('adult'):
            rec_picks.append(((k, x['id']), (x, None)))
    picks += rec_picks
    with ThreadPoolExecutor(max_workers=6) as ex:
        dets = list(ex.map(lambda kv: _safe_detail(*kv[0]), picks))
    for (key, (x, loose)), d in zip(picks, dets):
        if loose is None:  # recommendation: spin-off rule only
            why = spinoff_evidence(src, d) if d else None
        else:
            why = evidence(src, d) if d else None
        if why and loose and (why.startswith('company+') or (x.get('voteCount') or 0) < 50):
            # A title that only CONTAINS the name ("El Camino: A Breaking Bad Movie", "Jack Reacher") needs a specific
            # studio or shared people AND some audience: LEGO / Disk Wars / kids' specials of a mega-franchise don't.
            why = None
        if why and not x.get('posterPath'):
            why = None  # announced placeholders ("Untitled X-Men Film") and stubs: a blank card helps nobody
        if why and d and not (d.get('releaseDate') or d.get('firstAirDate')) and not d.get('productionCompanies'):
            why = None  # user-made duplicate entries (copied cast, no date, no studio)
        if why:
            found[key] = _slim(x, key[0], why)
        elif trace is not None and loose is not None:
            trace.append((key[0], x['id'], x.get('title') or x.get('name'), (x.get('releaseDate') or x.get('firstAirDate') or '')[:4]))

    found.pop((kind, int(tmdb_id)), None)
    # TMDB sometimes has the same special as both a movie and a TV entry (MvA: Supersonic Joyride): keep one.
    seen = {}
    for key, x in list(found.items()):
        dk = (norm_title(x.get('title') or x.get('name')), x['date'][:4])
        if dk in seen and x['why'] != 'collection':
            prev = seen[dk]
            loser = key if (prev[1]['votes'], prev[1]['mediaType'] == 'tv') >= (x['votes'], x['mediaType'] == 'tv') else prev[0]
            found.pop(loser, None)
            if loser == prev[0]:
                seen[dk] = (key, x)
        else:
            seen[dk] = (key, x)
    # Collection parts first in release order (the saga), then spin-offs most-voted first, so the long tail of
    # old cartoons / shorts sits at the end of the row.
    res = sorted(found.values(), key=lambda x: (x['why'] != 'collection', x['date'] if x['why'] == 'collection' else -x['votes'], x['id']))
    return res[:MAX_RESULTS]


def _safe_detail(kind, i):
    try:
        return detail(kind, i)
    except A.Upstream:
        return None


def related(query):
    q = urllib.parse.parse_qs(query)
    kind = (q.get('type') or [''])[0]
    sid = (q.get('id') or [''])[0]
    if kind not in ('movie', 'tv') or not sid.isdigit() or int(sid) <= 0:
        raise A.Upstream(400, 'type=movie|tv&id=<tmdb> required')
    k = (kind, int(sid))
    now = time.time()
    with _lock:
        hit = _cache.get(k)
        if hit and hit[0] > now:
            return {'results': hit[1]}
    try:
        res, ttl = compute(kind, int(sid)), TTL
    except A.Upstream as e:
        if e.code == 404:
            res, ttl = [], TTL
        else:
            raise
    with _lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[k] = (now + ttl, res)
    return {'results': res}
