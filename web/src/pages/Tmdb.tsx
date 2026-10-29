// Full-screen page for a TMDB title that isn't (fully) in the library: Detail.tsx's layout, fed by Seerr.
// Route { name: 'tmdb', type, id }. Request / options go through the same RequestSheet as the Requests tab.
import '../styles/requests.css';
import '../styles/tmdb.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { setBackdrop } from '../components/Backdrop';
import { Img } from '../components/Img';
import { Icon } from '../components/icons';
import { useAsync } from '../lib/useAsync';
import { focusEl, focusFirst, current } from '../lib/focus';
import { push } from '../lib/router';
import { log } from '../lib/log';
import { caps } from '../lib/caps';
import { isNative } from '../lib/bridge';
import { isAndroidTV } from '../lib/mode';
import { AVAIL_LABEL, SItem, availability, getDetail, me as getMe, ratings, related, titleOf, tmdbImg, yearOf, Me } from '../lib/seerr';
import { DatesList, RequestSheet, SCard, StatusChip, certOf, findInLibrary, seasonState, CHIP_ICON } from './Requests';
import { fmtDate } from '../lib/clock';
import { SameWorldRow, useTmdbExtras } from '../components/FranchiseRows';
import { tmdbKey } from '../lib/franchise';

let meCache: Promise<Me> | null = null;

/** Open a Seerr search/discover result: library item when we have it, else this page. */
export function openTmdb(it: SItem) {
  if (it.mediaType !== 'movie' && it.mediaType !== 'tv') return;
  const type = it.mediaType;
  const a = availability(it.mediaInfo);
  if (a === 'available' || a === 'partial') {
    findInLibrary(type, it.id, it.mediaInfo?.jellyfinMediaId)
      .catch((e) => (log('jf match failed', String(e)), null))
      .then((jf) => push(jf ? { name: 'item', id: jf } : { name: 'tmdb', type, id: it.id }));
    return;
  }
  push({ name: 'tmdb', type, id: it.id });
}

export function TmdbPage({ type, id, active }: { type: 'movie' | 'tv'; id: number; active: boolean }) {
  const [rev, setRev] = useState(0);
  const { data: d, error } = useAsync(() => getDetail(type, id), [type, id, rev]);
  const { data: rt } = useAsync(() => ratings(type, id).catch(() => null), [type, id]);
  const { data: recs } = useAsync(() => related(type, id, 'recommendations').catch(() => null), [type, id]);
  const { data: sim } = useAsync(() => related(type, id, 'similar').catch(() => null), [type, id]);
  const { x: world } = useTmdbExtras(type, id);
  const [user, setUser] = useState<Me | null>(null);
  const [jfId, setJfId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ season?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(null);

  useEffect(() => {
    (meCache ??= getMe()).then(setUser, () => (meCache = null));
  }, []);

  useEffect(() => {
    if (active && d) setBackdrop(tmdbImg(d.backdropPath, 'w1280'), 0.12, 0);
  }, [active, d?.backdropPath]);

  useEffect(() => {
    if (!active || !d || sheet) return;
    const raf = requestAnimationFrame(() => {
      const cur = current();
      if (!cur || !ref.current?.contains(cur)) focusFirst(ref.current, { instant: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, d?.id]);

  const a = availability(d?.mediaInfo);
  useEffect(() => {
    if (!d || (a !== 'available' && a !== 'partial')) return void setJfId(null);
    findInLibrary(type, id, d.mediaInfo?.jellyfinMediaId).then(setJfId, (e) => log('jf match failed', String(e)));
  }, [d, a]);

  if (error) return <div class="page-pad err">Couldn't load this title: {error.message}</div>;
  if (!d) return <TmdbSkeleton />;

  const title = titleOf(d);
  const sstate = type === 'tv' ? seasonState(d) : null;
  const seasons = (d.seasons ?? []).filter((s) => s.seasonNumber > 0);
  const anyFree = type === 'movie' ? a === 'none' : seasons.some((s) => sstate!(s.seasonNumber) === 'none');
  const canRequest = anyFree && caps.value?.requests !== false;
  const cert = certOf(d);
  const runtime = d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : d.episodeRunTime?.[0] ? `${d.episodeRunTime[0]} min episodes` : '';
  const trailer = d.relatedVideos?.find((v) => v.type === 'Trailer' && v.site === 'YouTube');
  // Opening YouTube would navigate the TV WebView away from the app: browsers only.
  const canTrailer = !!trailer && !isNative && !isAndroidTV;
  const cast = (d.credits?.cast ?? []).slice(0, 16);
  const year = yearOf(d);
  const status = type === 'tv' && d.status === 'Returning Series' ? `${year}–` : year;

  const openSheet = (season?: number) => {
    invoker.current = current();
    setSheet({ season });
  };
  const closeSheet = (changed?: boolean) => {
    setSheet(null);
    if (changed) setRev((r) => r + 1);
    requestAnimationFrame(() => {
      if (invoker.current?.isConnected) focusEl(invoker.current, { instant: true });
      else focusFirst(ref.current);
    });
  };
  const relRow = (label: string, key: string, items?: SItem[] | null) => {
    const inWorld = new Set((world?.world ?? []).map(tmdbKey));
    const xs = (items ?? [])
      .filter((x) => x.mediaType === 'movie' || x.mediaType === 'tv' || !x.mediaType)
      .map((x) => ({ ...x, mediaType: x.mediaType || type }))
      .filter((x) => !inWorld.has(tmdbKey(x)));
    return xs.length ? (
      <section class="row row-poster rq-row" data-group={`tm-${key}-${id}`} data-scrollunit>
        <h2 class="row-title">{label}</h2>
        <div class="row-viewport" data-hscroll>
          <div class="row-track">
            {xs.slice(0, 20).map((it) => (
              <SCard key={it.mediaType + it.id} it={it} fkey={`tm-${key}-${it.mediaType}-${it.id}`} onSelect={() => openTmdb(it)} onFocus={() => {}} />
            ))}
          </div>
        </div>
      </section>
    ) : null;
  };

  return (
    <>
      <div class="vscroll" ref={ref} data-vscroll data-margintop="8rem" data-marginbottom="5rem" data-group={`tmdb-${type}-${id}`}>
        <div class="vtrack page-pad">
          <div class="detail-head tm-head" data-scrolltop>
            <div class="rq-kicker">{type === 'tv' ? 'Series' : 'Movie'}</div>
            <div class="detail-title fade-swap">{title}</div>
            {d.tagline && <div class="tm-tagline">{d.tagline}</div>}
            <div class="hero-meta">
              {status && <span>{status}</span>}
              {cert && <span class="badge">{cert}</span>}
              {runtime && <span>{runtime}</span>}
              {d.numberOfSeasons ? <span>{d.numberOfSeasons} season{d.numberOfSeasons > 1 ? 's' : ''}</span> : null}
              {d.voteAverage ? (
                <span title="TMDB rating">
                  <Icon name="star" class="star" /> {d.voteAverage.toFixed(1)}
                </span>
              ) : null}
              {rt?.imdb?.criticsScore ? <span title="IMDb rating">IMDb {rt.imdb.criticsScore.toFixed(1)}</span> : null}
              {rt?.rt?.criticsScore != null ? <span title="Rotten Tomatoes critics">Critics {rt.rt.criticsScore}%</span> : null}
              {rt?.rt?.audienceScore != null ? <span title="Rotten Tomatoes audience">Audience {rt.rt.audienceScore}%</span> : null}
              {d.networks?.[0] && <span>{d.networks[0].name}</span>}
            </div>
            {d.genres?.length ? <div class="detail-genres">{d.genres.map((g) => g.name).join(' · ')}</div> : null}
            {d.overview && <div class="detail-overview">{d.overview}</div>}
            <div class="rq-status-line">
              <StatusChip a={a} />
              {a === 'none' && <span class="rq-chip none">Not requested</span>}
            </div>
            <DatesList type={type} id={id} />
            <div class="btn-row" data-group="tm-actions">
              {jfId && (
                <div class="btn focusable" tabIndex={-1} data-autofocus data-fkey="tm-play" onClick={() => push({ name: 'item', id: jfId })}>
                  <Icon name="play" fill /> Play in Jellyfin
                </div>
              )}
              {canRequest && (
                <div class="btn focusable" tabIndex={-1} data-autofocus={!jfId || undefined} data-fkey="tm-request" onClick={() => openSheet()}>
                  <Icon name="requests" /> {type === 'tv' && a !== 'none' ? 'Request more' : 'Request'}
                </div>
              )}
              {canTrailer && (
                <div class="btn focusable" tabIndex={-1} data-fkey="tm-trailer" onClick={() => window.open(trailer!.url || `https://www.youtube.com/watch?v=${trailer!.key}`, '_blank', 'noopener')}>
                  <Icon name="trailer" /> Trailer
                </div>
              )}
            </div>
          </div>

          {type === 'tv' && seasons.length > 0 && (
            <section class="row row-poster tm-seasons" data-group={`tm-seasons-${id}`} data-scrollunit>
              <h2 class="row-title">Seasons</h2>
              <div class="row-viewport" data-hscroll>
                <div class="row-track">
                  {seasons.map((s) => {
                    const st = sstate!(s.seasonNumber);
                    const free = st === 'none';
                    return (
                      <div
                        key={s.seasonNumber}
                        class="card poster focusable"
                        tabIndex={-1}
                        data-fkey={`tm-season-${s.seasonNumber}`}
                        onClick={() => (free ? canRequest && openSheet(s.seasonNumber) : jfId && push({ name: 'item', id: jfId }))}
                      >
                        <div class="card-art">
                          <Img src={tmdbImg(s.posterPath ?? d.posterPath)} alt={s.name} />
                          <StatusChip a={st} small />
                        </div>
                        <div class="card-text tm-season-text">
                          <div class="card-title">{s.name}</div>
                          <div class="card-sub">
                            {[s.episodeCount ? `${s.episodeCount} ep` : '', s.airDate ? fmtDate(s.airDate, 'auto') : 'TBA'].filter(Boolean).join(' · ')}
                          </div>
                          <div class={'tm-season-st ' + st}>
                            {!free && <Icon name={st === 'available' ? 'watched' : CHIP_ICON[st]} />}
                            {free ? (canRequest ? 'Request' : '') : AVAIL_LABEL[st]}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {cast.length > 0 && (
            <section class="row" data-group={`tm-cast-${id}`} data-scrollunit>
              <h2 class="row-title">Cast</h2>
              <div class="row-viewport" data-hscroll>
                <div class="row-track people">
                  {cast.map((p) => (
                    <div
                      class="person focusable card"
                      tabIndex={-1}
                      key={p.id}
                      data-fkey={'tm-cast-' + p.id}
                      onClick={() => push({ name: 'person', tmdbId: p.id })}
                    >
                      <div class="face">
                        <Img src={tmdbImg(p.profilePath, 'w342')} alt={p.name.split(' ').map((x) => x[0]).join('')} />
                      </div>
                      <div class="nm">{p.name}</div>
                      <div class="rl">{p.character}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          <SameWorldRow x={world} gid={`tm-${type}-${id}`} />
          {relRow('Recommended', 'recs', recs?.results)}
          {relRow('Similar', 'sim', sim?.results)}
        </div>
      </div>
      {sheet &&
        createPortal(
          <RequestSheet key={'tm' + type + id} type={type} id={id} seed={d} season={sheet.season} visible={active} user={user} fromPage onClose={closeSheet} />,
          document.getElementById('app') ?? document.body,
        )}
    </>
  );
}

function TmdbSkeleton() {
  return (
    <div class="page-pad">
      <div class="detail-head">
        <div class="sk" style={{ width: '30rem', height: '4.4rem', marginBottom: '1.4rem' }} />
        <div class="sk" style={{ width: '24rem', height: '1.4rem', marginBottom: '1rem' }} />
        <div class="sk" style={{ width: '48rem', height: '5rem', marginBottom: '1.8rem' }} />
        <div class="btn-row">
          <div class="sk" style={{ width: '12rem', height: '3.6rem' }} />
        </div>
      </div>
    </div>
  );
}
