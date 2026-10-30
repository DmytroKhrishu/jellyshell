import '../styles/requests.css';
import '../styles/tmdb.css';
import { Icon, IconName } from '../components/icons';
// "Requests" tab: Seerr discover rows, TMDB search, detail sheet with Request / Play in Jellyfin.
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Img } from '../components/Img';
import { SkeletonRow } from '../components/Card';
import { setBackdrop } from '../components/Backdrop';
import { showToast } from '../components/Dialog';
import { TextField } from './Login';
import {
  SItem, SDetail, MyRequest, Me, AVAIL_LABEL, Avail, MS, availability, createRequest, discover, getDetail, me as getMe,
  myRequests, requestStatusLabel, searchTmdb, titleOf, tmdbImg, yearOf, ProxyError, requestOptions, ServerOpts, MinAvail, MIN_AVAIL_LABEL, RequestBody,
} from '../lib/seerr';
import { api, auth } from '../lib/jellyfin';
import { push } from '../lib/router';
import { focusEl, focusFirst, current } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { useInitialFocus } from '../lib/useInitialFocus';
import { log } from '../lib/log';
import { caps } from '../lib/caps';
import { cardDates, dateRows, peekDates, wantDates, whenVisible } from '../lib/releases';

interface Rows {
  trending: SItem[];
  movies: SItem[];
  tv: SItem[];
  upcoming: SItem[];
}

const media = (xs: SItem[]) => xs.filter((x) => x.mediaType === 'movie' || x.mediaType === 'tv');

export function Requests({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<MyRequest[] | null>(null);
  const [user, setUser] = useState<Me | null>(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ type: 'movie' | 'tv'; id: number; seed?: SItem } | null>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const opening = useRef(false);
  const [rev, setRev] = useState(0);

  useInitialFocus(ref, active && !sheet, !!rows || !!err);

  // Discover rows (once) + my requests (every time the tab is shown / after a request).
  useEffect(() => {
    if (!active || rows) return;
    const v = <T,>(p: PromiseSettledResult<{ results: T[] }>) => (p.status === 'fulfilled' ? p.value.results : []);
    Promise.allSettled([discover.trending(), discover.movies(), discover.tv(), discover.upcoming()]).then(([t, m, tv, u]) => {
      if ([t, m, tv, u].every((p) => p.status === 'rejected')) {
        const r = (t as PromiseRejectedResult).reason;
        setErr(r instanceof ProxyError ? r.message : String(r));
        log('seerr discover failed', String(r));
        return;
      }
      setRows({ trending: media(v(t)), movies: media(v(m)), tv: media(v(tv)), upcoming: media(v(u)) });
    });
  }, [active]);
  useEffect(() => {
    if (!active) return;
    myRequests()
      .then((r) => {
        setMine(r.results);
        setUser(r.user);
      })
      .catch((e) => {
        log('myrequests failed', String(e));
        getMe().then(setUser, () => {});
      });
  }, [active, rev]);

  useEffect(() => {
    if (active && !sheet) setBackdrop(null, 0.6, 0);
  }, [active]);

  // Live TMDB search, debounced.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRes(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      searchTmdb(term, ac.signal)
        .then((r) => setRes(media(r.results)))
        .catch((e) => e.name !== 'AbortError' && setRes([]))
        .finally(() => setBusy(false));
    }, 350);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  // Y = jump to the search field (like the Search tab).
  useEffect(() => {
    if (!active || sheet) return;
    return pushHandler((e) => {
      if (e.action === 'y' && !e.repeat) {
        const f = ref.current?.querySelector<HTMLElement>('.field');
        focusEl(f);
        f?.querySelector('input')?.focus();
        return true;
      }
      return false;
    });
  }, [active, sheet]);

  const open = (it: { mediaType: string; id: number }, seed?: SItem) => {
    if (it.mediaType !== 'movie' && it.mediaType !== 'tv') return;
    const type = it.mediaType;
    const card = current();
    const a = availability(seed?.mediaInfo);
    // Already in the library: go straight to the Jellyfin detail page (B returns to this card).
    if (a === 'available' || a === 'partial') {
      if (opening.current) return;
      opening.current = true;
      findInLibrary(type, it.id, seed?.mediaInfo?.jellyfinMediaId)
        .catch((e) => (log('jf match failed', String(e)), null))
        .then((jf) => {
          opening.current = false;
          if (!active) return;
          if (jf) {
            if (card?.isConnected) focusEl(card, { instant: true });
            push({ name: 'item', id: jf });
          } else {
            invoker.current = card;
            setSheet({ type, id: it.id, seed });
          }
        });
      return;
    }
    invoker.current = card;
    setSheet({ type, id: it.id, seed });
  };
  const close = (changed?: boolean) => {
    setSheet(null);
    if (changed) setRev((r) => r + 1);
    requestAnimationFrame(() => {
      if (invoker.current?.isConnected) focusEl(invoker.current, { instant: true });
      else focusFirst(ref.current);
    });
  };
  const onCardFocus = (it: SItem) => setBackdrop(tmdbImg(it.backdropPath, 'w1280'), 0.55);

  const row = (title: string, id: string, items: SItem[] | undefined) =>
    items && items.length ? (
      <section class="row row-poster rq-row" data-group={id} data-scrollunit key={id}>
        <h2 class="row-title">{title}</h2>
        <div class="row-viewport" data-hscroll>
          <div class="row-track">
            {items.map((it) => (
              <SCard key={it.mediaType + it.id} it={it} fkey={`${id}-${it.mediaType}-${it.id}`} onSelect={() => open(it, it)} onFocus={() => onCardFocus(it)} />
            ))}
          </div>
        </div>
      </section>
    ) : null;

  return (
    <>
      <div class="vscroll" ref={ref} data-vscroll data-margintop="10rem" data-marginbottom="4rem" data-group="requests">
        <div class="vtrack page-pad">
          <div class="rq-head" data-scrolltop>
            <div class="rq-search">
              <TextField label="Request" icon="search" value={q} onInput={setQ} placeholder="Find a movie or show to request…" />
            </div>
            <div class="muted rq-hint">
              {busy
                ? 'Searching TMDB…'
                : res && !res.length
                  ? 'No results'
                  : caps.value?.requests === false
                    ? "Requests aren't enabled for your account. Ask the server owner to link your Jellyfin user in Seerr."
                    : user && !user.attributed
                    ? `Requests will be filed by the server admin (no Seerr account for ${user.jellyfinName})`
                    : user
                      ? `Requesting as ${user.displayName}` + (document.documentElement.classList.contains('mode-mobile') ? '' : ' · Y jumps to search')
                      : 'Y jumps to search'}
            </div>
          </div>
          {err && <div class="rq-error">Seerr is unreachable: {err}</div>}
          {res && res.length > 0 && row('Search results', 'rq-search', res)}
          {mine && mine.length > 0 && (
            <section class="row row-poster rq-row" data-group="rq-mine" data-scrollunit>
              <h2 class="row-title">My Requests</h2>
              <div class="row-viewport" data-hscroll>
                <div class="row-track">
                  {mine.map((r) => (
                    <MineCard
                      key={r.id}
                      r={r}
                      onSelect={() =>
                        open(
                          { mediaType: r.mediaType, id: r.tmdbId },
                          {
                            id: r.tmdbId,
                            mediaType: r.mediaType,
                            title: r.title,
                            posterPath: r.posterPath,
                            backdropPath: r.backdropPath,
                            mediaInfo: { status: r.mediaStatus, jellyfinMediaId: r.jellyfinMediaId },
                          },
                        )
                      }
                      onFocus={() => setBackdrop(tmdbImg(r.backdropPath, 'w1280'), 0.55)}
                    />
                  ))}
                </div>
              </div>
            </section>
          )}
          {!rows && !err && (
            <>
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}
          {rows && (
            <>
              {row('Trending', 'rq-trending', rows.trending)}
              {row('Popular Movies', 'rq-movies', rows.movies)}
              {row('Popular Shows', 'rq-tv', rows.tv)}
              {row('Upcoming Movies', 'rq-upcoming', rows.upcoming)}
            </>
          )}
        </div>
      </div>
      {sheet &&
        createPortal(
          <RequestSheet key={sheet.type + sheet.id} type={sheet.type} id={sheet.id} seed={sheet.seed} visible={active} user={user} onClose={close} />,
          document.getElementById('app') ?? document.body,
        )}
    </>
  );
}

export const CHIP_ICON: Record<Avail | 'failed', IconName> = {
  available: 'check',
  partial: 'partial',
  processing: 'clock',
  pending: 'pending',
  failed: 'alert',
  none: 'requests',
};

export function StatusChip({ a, small }: { a: Avail | 'failed'; small?: boolean }) {
  if (a === 'none') return null;
  const label = a === 'failed' ? 'Failed' : AVAIL_LABEL[a];
  return (
    <span class={`rq-chip ${a}${small ? ' small' : ''}`} title={label}>
      <Icon name={CHIP_ICON[a]} stroke={small ? 3 : 2.4} />
      {!small && label}
    </span>
  );
}

export function SCard({ it, fkey, onSelect, onFocus }: { it: SItem; fkey: string; onSelect: () => void; onFocus: () => void }) {
  const title = titleOf(it);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => whenVisible(ref.current, () => wantDates(it.mediaType, it.id)), [it.mediaType, it.id]);
  const dt = cardDates(peekDates(it.mediaType, it.id), yearOf(it));
  return (
    <div class="card poster focusable" tabIndex={-1} data-fkey={fkey} onClick={onSelect} onFocus={onFocus} ref={ref}>
      <div class="card-art">
        <Img src={tmdbImg(it.posterPath)} alt={title} />
        <StatusChip a={availability(it.mediaInfo)} small />
        {dt.coming && (
          <div class="rq-coming">
            <Icon name="calendar" stroke={2.4} />
            {dt.coming}
          </div>
        )}
      </div>
      <div class="card-text">
        <div class="card-title">{title}</div>
        <div class="card-sub">{[dt.text, it.mediaType === 'tv' ? 'Show' : 'Movie'].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}

function MineCard({ r, onSelect, onFocus }: { r: MyRequest; onSelect: () => void; onFocus: () => void }) {
  const st = requestStatusLabel(r);
  return (
    <div class="card poster focusable rq-mine" tabIndex={-1} data-fkey={'rq-mine-' + r.id} onClick={onSelect} onFocus={onFocus}>
      <div class="card-art">
        <Img src={tmdbImg(r.posterPath)} alt={r.title} />
        <div class={'rq-banner ' + st.tone}>{st.label}</div>
      </div>
      <div class="card-text">
        <div class="card-title">{r.title}</div>
        <div class="card-sub">
          {r.mediaType === 'tv' && r.seasons.length ? `Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}` : r.year}
        </div>
      </div>
    </div>
  );
}

// ---------------- detail sheet ----------------
export function seasonState(d: SDetail) {
  const mi = d.mediaInfo;
  const avail = new Map<number, number>();
  for (const s of mi?.seasons ?? []) avail.set(s.seasonNumber, s.status);
  const requested = new Set<number>();
  for (const r of mi?.requests ?? []) if (r.status !== 3 && r.status !== 4) for (const s of r.seasons ?? []) requested.add(s.seasonNumber);
  return (n: number): Avail => {
    const st = avail.get(n);
    if (st === MS.AVAILABLE) return 'available';
    if (st === MS.PARTIAL) return 'partial';
    if (st === MS.PROCESSING || requested.has(n)) return 'processing';
    if (st === MS.PENDING) return 'pending';
    return 'none';
  };
}

export function certOf(d: SDetail) {
  const tv = d.contentRatings?.results?.find((r) => r.iso_3166_1 === 'US')?.rating;
  const mv = d.releases?.results?.find((r) => r.iso_3166_1 === 'US')?.release_dates?.find((x) => x.certification)?.certification;
  return tv || mv || '';
}

export async function findInLibrary(type: 'movie' | 'tv', tmdbId: number, hint?: string | null): Promise<string | null> {
  const uid = auth.value?.userId;
  // Seerr's jellyfinMediaId can be stale after a rescan: verify it, else look up by TMDB id.
  if (hint) {
    const ok = await api<{ Id: string }>(`/Users/${uid}/Items/${hint}`).then((x) => !!x?.Id, () => false);
    if (ok) return hint;
  }
  // Jellyfin 10.11 ignores AnyProviderIdEquals (returns everything), so match ProviderIds here.
  const r = await api<{ Items: { Id: string; ProviderIds?: Record<string, string> }[] }>(
    `/Items?userId=${uid}&Recursive=true&IncludeItemTypes=${type === 'tv' ? 'Series' : 'Movie'}&Fields=ProviderIds&EnableImages=false&EnableUserData=false`,
  );
  return r.Items.find((x) => x.ProviderIds?.Tmdb === String(tmdbId))?.Id ?? null;
}

/** Release dates list (sheet + full page). */
export function DatesList({ type, id }: { type: 'movie' | 'tv'; id: number }) {
  useEffect(() => wantDates(type, id), [type, id]);
  const rows = dateRows(peekDates(type, id));
  if (!rows.length) return null;
  return (
    <div class="rq-dates">
      {rows.map((r) => (
        <div class={'rq-date' + (r.coming ? ' coming' : '')} key={r.label}>
          <span class="rq-date-l">{r.label}</span>
          <span class="rq-date-v">
            {r.coming && <Icon name="calendar" />}
            {r.value}
          </span>
          {r.sub && <span class="rq-date-s">{r.sub}</span>}
        </div>
      ))}
    </div>
  );
}

export function RequestSheet(p: {
  type: 'movie' | 'tv';
  id: number;
  seed?: SItem;
  visible: boolean;
  user: Me | null;
  onClose: (changed?: boolean) => void;
  /** Opened from the full TMDB page: no "More Info" (we're already there). */
  fromPage?: boolean;
  /** Pre-select only this season (season card on the TMDB page). */
  season?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<SDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [jfId, setJfId] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [opts, setOpts] = useState<ServerOpts[] | null>(null);
  const [pick, setPick] = useState<ReqPick | null>(null);
  const changed = useRef(false);
  const wasConfirm = useRef(false);
  const landed = useRef(false);

  useEffect(() => {
    getDetail(p.type, p.id).then(setD, (e) => setErr(String(e?.message ?? e)));
  }, [p.type, p.id]);

  const base: SItem | null = d ?? p.seed ?? null;
  const a = availability(d?.mediaInfo ?? p.seed?.mediaInfo);
  const sstate = d && p.type === 'tv' ? seasonState(d) : null;
  const realSeasons = (d?.seasons ?? []).filter((s) => s.seasonNumber > 0);
  const requestable = sstate ? realSeasons.filter((s) => sstate(s.seasonNumber) === 'none').map((s) => s.seasonNumber) : [];
  const canRequest = !!d && (p.type === 'movie' ? a === 'none' : requestable.length > 0) && !done && caps.value?.requests !== false;

  useEffect(() => {
    if (d && p.type === 'tv' && sel === null) setSel(new Set(p.season != null && requestable.includes(p.season) ? [p.season] : requestable));
  }, [d]);

  // Advanced options (quality profile / release threshold): only for users the proxy says may use them.
  useEffect(() => {
    if (!canRequest || !p.user?.advanced || opts) return;
    requestOptions(p.type).then(
      (r) => {
        setOpts(r.advanced ? r.servers : []);
        if (r.advanced && r.servers[0]) setPick(defaultPick(r.servers[0]));
      },
      (e) => (log('request options failed', String(e)), setOpts([])),
    );
  }, [canRequest, p.user?.advanced]);

  // Library match for "Play in Jellyfin" (available or partially available).
  useEffect(() => {
    if (!d || (a !== 'available' && a !== 'partial')) return;
    findInLibrary(p.type, p.id, d.mediaInfo?.jellyfinMediaId).then(setJfId, (e) => log('jf match failed', String(e)));
  }, [d, a]);

  useEffect(() => {
    if (p.visible && base && !p.fromPage) setBackdrop(tmdbImg(base.backdropPath, 'w1280'), 0.25, 0);
  }, [p.visible, base?.backdropPath]);

  // Focus: first action once data arrives; keep focus inside the sheet.
  useEffect(() => {
    if (!p.visible) return;
    const id = requestAnimationFrame(() => {
      // Confirmation / options dialog: default focus is Cancel.
      if (confirm) return void focusEl(document.querySelector<HTMLElement>('[data-fkey="rq-cancel"]'), { instant: true });
      const cur = current();
      const auto = ref.current?.querySelector<HTMLElement>('.rq-actions [data-autofocus]');
      // Data/library match arrived while only "More Info"/"Close" existed: move to the primary action (once).
      const placeholder = cur?.dataset.fkey === 'rq-close' || (cur?.dataset.fkey === 'rq-more' && !landed.current);
      if (auto && cur === auto) landed.current = true;
      if (placeholder && auto && !wasConfirm.current) {
        focusEl(auto, { instant: true });
        landed.current = true;
      }
      else if (!cur || !ref.current?.contains(cur)) {
        const req = ref.current?.querySelector<HTMLElement>('[data-fkey="rq-request"]');
        if (!(wasConfirm.current && req && focusEl(req, { instant: true }))) focusFirst(ref.current, { instant: true });
      }
      wasConfirm.current = false;
    });
    if (confirm) wasConfirm.current = true;
    return () => cancelAnimationFrame(id);
  }, [p.visible, !!d, jfId, confirm, done]);

  // B closes (confirm first), shoulder/Y/View are swallowed so the tab doesn't change under the sheet.
  useEffect(() => {
    if (!p.visible) return;
    return pushHandler((e) => {
      switch (e.action) {
        case 'back':
          if (e.repeat) return true;
          if (confirm) setConfirm(false);
          else p.onClose(changed.current);
          return true;
        case 'lb':
        case 'rb':
        case 'y':
        case 'view':
        case 'x':
        case 'menu':
          return true;
      }
      return false;
    });
  }, [p.visible, confirm]);

  const allSelected = p.type === 'tv' && sel && requestable.length > 0 && requestable.every((n) => sel.has(n));
  const toggleSeason = (n: number) => {
    const s = new Set(sel ?? []);
    if (s.has(n)) s.delete(n);
    else s.add(n);
    setSel(s);
  };
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(requestable));

  const server = opts?.find((s) => s.id === pick?.serverId) ?? null;
  const submit = async () => {
    setConfirm(false);
    setSending(true);
    try {
      const seasons = p.type === 'tv' ? (allSelected && requestable.length === realSeasons.length ? 'all' : [...(sel ?? [])].sort((x, y) => x - y)) : undefined;
      const r = await createRequest({ mediaType: p.type, mediaId: p.id, seasons, ...advancedBody(server, pick, p.type) });
      changed.current = true;
      const msg = r.attributed ? `Requested as ${r.attributedTo}` : 'Requested (filed by the server admin)';
      setDone(msg);
      showToast(msg);
      log('seerr request created', { id: r.request.id, type: p.type, tmdb: p.id, adv: advancedBody(server, pick, p.type) });
      getDetail(p.type, p.id).then(setD, () => {});
    } catch (e: any) {
      log('seerr request failed', String(e?.message ?? e));
      setDone(null);
      setErr(`Request failed: ${e?.message ?? e}`);
    } finally {
      setSending(false);
    }
  };

  const openPage = () => {
    p.onClose(changed.current);
    // after the sheet closed and focus returned to the card, so B on the page lands there
    requestAnimationFrame(() => requestAnimationFrame(() => push({ name: 'tmdb', type: p.type, id: p.id })));
  };

  const title = base ? titleOf(base) : '';
  const year = base ? yearOf(base) : '';
  const runtime = d?.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : d?.episodeRunTime?.[0] ? `${d.episodeRunTime[0]} min episodes` : '';
  const cert = d ? certOf(d) : '';
  const nSel = sel?.size ?? 0;
  const reqLabel =
    p.type === 'movie' ? 'Request' : allSelected ? (a === 'none' ? 'Request all seasons' : 'Request remaining seasons') : `Request ${nSel} season${nSel === 1 ? '' : 's'}`;

  return (
    <div class={'rq-sheet-wrap' + (p.visible ? '' : ' hidden')}>
      <div class="rq-sheet" data-scope ref={ref}>
        <div class="rq-poster">
          <Img src={tmdbImg(base?.posterPath, 'w500')} alt={title} eager />
        </div>
        <div class="rq-body">
          <div class="rq-kicker">{p.type === 'tv' ? 'Series' : 'Movie'}</div>
          <div class="rq-title">{title || '…'}</div>
          <div class="hero-meta">
            {year && <span>{year}</span>}
            {cert && <span class="badge">{cert}</span>}
            {runtime && <span>{runtime}</span>}
            {d?.numberOfSeasons ? <span>{d.numberOfSeasons} season{d.numberOfSeasons > 1 ? 's' : ''}</span> : null}
            {base?.voteAverage ? (
              <span>
                <Icon name="star" class="star" /> {base.voteAverage.toFixed(1)}
              </span>
            ) : null}
          </div>
          <div class="rq-status-line">
            <StatusChip a={done ? 'processing' : a} />
            {a === 'none' && !done && <span class="rq-chip none">Not requested</span>}
            {done && <span class="muted">{done}</span>}
          </div>
          <DatesList type={p.type} id={p.id} />
          {d?.genres?.length ? <div class="detail-genres">{d.genres.map((g) => g.name).join(' · ')}</div> : null}
          {(d?.overview || base?.overview) && <div class="rq-overview">{d?.overview || base?.overview}</div>}
          {err && <div class="err rq-err">{err}</div>}

          {p.type === 'tv' && d && realSeasons.length > 0 && !done && (
            <div class="rq-seasons" data-group="rq-seasons">
              {requestable.length > 1 && (
                <div class={'pill focusable' + (allSelected ? ' selected' : '')} tabIndex={-1} data-fkey="rq-s-all" onClick={toggleAll}>
                  {allSelected && <Icon name="check" />}All seasons
                </div>
              )}
              {realSeasons.map((s) => {
                const st = sstate!(s.seasonNumber);
                const free = st === 'none';
                return (
                  <div
                    key={s.seasonNumber}
                    class={'pill rq-season focusable' + (free && sel?.has(s.seasonNumber) ? ' selected' : '') + (free ? '' : ' locked ' + st)}
                    tabIndex={-1}
                    data-fkey={'rq-s-' + s.seasonNumber}
                    onClick={() => free && toggleSeason(s.seasonNumber)}
                    title={AVAIL_LABEL[st]}
                  >
                    {free ? sel?.has(s.seasonNumber) && <Icon name="check" /> : <Icon name={st === 'available' ? 'watched' : CHIP_ICON[st]} />}
                    S{s.seasonNumber}
                    <small>{free ? `${s.episodeCount} ep` : AVAIL_LABEL[st]}</small>
                  </div>
                );
              })}
            </div>
          )}

          <div class="btn-row rq-actions" data-group="rq-actions">
            {jfId && (
              <div
                class="btn focusable"
                tabIndex={-1}
                data-autofocus
                data-fkey="rq-play"
                onClick={() => {
                  p.onClose(changed.current);
                  // after the sheet closed and focus returned to the card, so B on the detail page lands there
                  requestAnimationFrame(() => requestAnimationFrame(() => push({ name: 'item', id: jfId })));
                }}
              >
                <Icon name="play" fill /> Play in Jellyfin
              </div>
            )}
            {canRequest && (
              <div
                class={'btn focusable rq-req' + (p.type === 'tv' && !nSel ? ' disabled' : '')}
                tabIndex={-1}
                data-autofocus={!jfId || undefined}
                data-fkey="rq-request"
                onClick={() => !sending && (p.type === 'movie' || nSel > 0) && setConfirm(true)}
              >
                {sending ? <span class="spinner" /> : <Icon name="requests" />} {sending ? 'Requesting…' : reqLabel}
              </div>
            )}
            {!p.fromPage && (
              <div class="btn focusable" tabIndex={-1} data-fkey="rq-more" onClick={openPage}>
                <Icon name="info" /> More Info
              </div>
            )}
            <div class="btn focusable" tabIndex={-1} data-fkey="rq-close" onClick={() => p.onClose(changed.current)}>
              Close
            </div>
          </div>
          {!d && !err && <div class="qc-wait rq-loading"><span class="spinner" /> Loading details…</div>}
        </div>
      </div>
      {confirm && (
        <div class="dialog-wrap rq-confirm-wrap">
          <div class={'dialog rq-confirm' + (server ? ' with-opts' : '')} data-scope>
            <div class="dialog-col">
              <h3>{server ? 'Request options' : 'Confirm request'}</h3>
              <div class="rq-confirm-text">
                {p.type === 'movie' ? `Request “${title}”?` : `Request ${allSelected && a === 'none' ? 'all seasons' : `season${nSel === 1 ? '' : 's'} ${[...(sel ?? [])].sort((x, y) => x - y).join(', ')}`} of “${title}”?`}
                <div class="muted">
                  {p.user?.attributed ? `Filed as ${p.user.displayName}.` : 'Filed by the server admin.'} It downloads automatically once approved.
                </div>
              </div>
              {server && pick && <RequestOptions type={p.type} servers={opts!} server={server} pick={pick} onPick={setPick} />}
              <div class="btn-row" data-group="rq-confirm">
                <div class="btn focusable" tabIndex={-1} data-autofocus data-fkey="rq-cancel" onClick={() => setConfirm(false)}>
                  Cancel
                </div>
                <div class="btn focusable" tabIndex={-1} data-fkey="rq-confirm" onClick={submit}>
                  <Icon name="requests" /> Request
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- advanced request options ----------------
export interface ReqPick {
  serverId: number;
  profileId?: number;
  rootFolder?: string;
  minimumAvailability?: MinAvail;
}
export const defaultPick = (s: ServerOpts): ReqPick => ({
  serverId: s.id,
  profileId: s.activeProfileId,
  rootFolder: s.activeDirectory,
  minimumAvailability: s.minimumAvailability,
});
/** Only what differs from the Seerr defaults goes out, so a straight-through request is the same body as before. */
export function advancedBody(server: ServerOpts | null, pick: ReqPick | null, type: 'movie' | 'tv'): Partial<RequestBody> {
  if (!server || !pick) return {};
  const def = defaultPick(server);
  const out: Partial<RequestBody> = {};
  if (!server.isDefault) out.serverId = server.id;
  if (pick.profileId != null && pick.profileId !== def.profileId) out.profileId = pick.profileId;
  if (pick.rootFolder && pick.rootFolder !== def.rootFolder) out.rootFolder = pick.rootFolder;
  if (type === 'movie' && pick.minimumAvailability && pick.minimumAvailability !== def.minimumAvailability) out.minimumAvailability = pick.minimumAvailability;
  if (Object.keys(out).length && out.serverId == null) out.serverId = server.id;
  return out;
}

function OptRow<T extends string | number>(p: { label: string; id: string; value: T | undefined; def: T | undefined; options: { value: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div class="rq-opt">
      <div class="rq-opt-l">{p.label}</div>
      <div class="rq-opt-pills" data-group={'rq-opt-' + p.id}>
        {p.options.map((o) => (
          <div
            key={String(o.value)}
            class={'pill focusable' + (o.value === p.value ? ' selected' : '')}
            tabIndex={-1}
            data-fkey={`rq-opt-${p.id}-${o.value}`}
            onClick={() => p.onPick(o.value)}
          >
            {o.value === p.value && <Icon name="check" />}
            {o.label}
            {o.value === p.def && <small class="rq-def">default</small>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RequestOptions(p: { type: 'movie' | 'tv'; servers: ServerOpts[]; server: ServerOpts; pick: ReqPick; onPick: (x: ReqPick) => void }) {
  const s = p.server;
  return (
    <div class="rq-opts">
      {p.servers.length > 1 && (
        <OptRow label="Server" id="srv" value={s.id} def={p.servers.find((x) => x.isDefault)?.id} options={p.servers.map((x) => ({ value: x.id, label: x.name }))} onPick={(id) => p.onPick(defaultPick(p.servers.find((x) => x.id === id)!))} />
      )}
      <OptRow label="Quality" id="q" value={p.pick.profileId} def={s.activeProfileId} options={s.profiles.map((x) => ({ value: x.id, label: x.name }))} onPick={(v) => p.onPick({ ...p.pick, profileId: v })} />
      {p.type === 'movie' && (
        <OptRow
          label="Grab when"
          id="ma"
          value={p.pick.minimumAvailability}
          def={s.minimumAvailability}
          options={(Object.keys(MIN_AVAIL_LABEL) as MinAvail[]).map((v) => ({ value: v, label: MIN_AVAIL_LABEL[v] }))}
          onPick={(v) => p.onPick({ ...p.pick, minimumAvailability: v })}
        />
      )}
      {s.rootFolders.length > 1 && (
        <OptRow label="Folder" id="rf" value={p.pick.rootFolder} def={s.activeDirectory} options={s.rootFolders.map((x) => ({ value: x.path, label: x.path }))} onPick={(v) => p.onPick({ ...p.pick, rootFolder: v })} />
      )}
    </div>
  );
}
