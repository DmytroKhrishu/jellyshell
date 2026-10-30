import { useEffect, useRef, useState } from 'preact/hooks';
import { setBackdrop } from '../components/Backdrop';
import { Card, Row } from '../components/Card';
import { openPicker, showToast } from '../components/Dialog';
import { openFinder } from '../components/SubtitleFinder';
import { openSeriesSubs } from '../components/SeriesSubs';
import { caps } from '../lib/caps';
import {
  Item, backdropUrl, episodes, fmtRuntime, item as getItem, logoUrl, seasons, seriesNextUp, setFavorite, setPlayed,
  similar, episodeLabel, TICKS_PER_MS, fmtClock, thumbUrl,
} from '../lib/jellyfin';
import { useAsync } from '../lib/useAsync';
import { focusEl, focusFirst, current, remember, focusedKey } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { playItem, contextMenu } from '../lib/actions';
import { mediaBadges, streams, audioLabel, subLabel, pickTracks } from '../lib/media';
import { rememberAudio, rememberSub } from '../lib/trackmem';
import { push } from '../lib/router';
import { log } from '../lib/log';
import { endsAt } from '../lib/clock';
import { dataRev } from '../lib/datasync';
import { Icon } from '../components/icons';
import { PersonCard } from '../components/PersonCard';
import { MoreLikeThis, SameWorldRow, useTmdbExtras } from '../components/FranchiseRows';
import '../styles/seasons.css';

export function Detail({ id, seasonId, active }: { id: string; seasonId?: string; active: boolean }) {
  const [rev, setRev] = useState(0);
  const drev = dataRev.value; // watched / progress / favorite changed anywhere (incl. playback stop): refetch in place
  const { data: it, error } = useAsync(() => getItem(id), [id, rev, drev]);
  const ref = useRef<HTMLDivElement>(null);
  const isSeries = it?.Type === 'Series';

  // Re-fetch when returning to this page (progress/watched may have changed in the player).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setRev((r) => r + 1);
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (active && it) setBackdrop(backdropUrl(it), 0.12, 0);
  }, [active, it?.Id]);

  useEffect(() => {
    if (!active || !it) return;
    const id = requestAnimationFrame(() => {
      const cur = current();
      if (!cur || !ref.current?.contains(cur)) focusFirst(ref.current, { instant: true });
    });
    return () => cancelAnimationFrame(id);
  }, [active, it?.Id]);

  if (error) return <div class="page-pad err">Couldn't load item: {error.message}</div>;
  if (!it) return <DetailSkeleton />;

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="8rem" data-marginbottom="5rem" data-group={'detail-' + id}>
      <div class="vtrack page-pad">
        {isSeries ? (
          <SeriesBody series={it} active={active} initialSeason={seasonId} rev={rev + drev * 1000} onChanged={() => setRev((r) => r + 1)} />
        ) : (
          <>
            <Head it={it} active={active} onChanged={() => setRev((r) => r + 1)} />
            <Extras it={it} />
          </>
        )}
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div class="page-pad">
      <div class="detail-head">
        <div class="sk" style={{ width: '30rem', height: '6rem', marginBottom: '1.4rem' }} />
        <div class="sk" style={{ width: '24rem', height: '1.4rem', marginBottom: '1rem' }} />
        <div class="sk" style={{ width: '48rem', height: '5rem', marginBottom: '1.8rem' }} />
        <div class="btn-row">
          <div class="sk" style={{ width: '12rem', height: '3.6rem' }} />
          <div class="sk" style={{ width: '12rem', height: '3.6rem' }} />
        </div>
      </div>
    </div>
  );
}

function MetaLine({ it }: { it: Item }) {
  const badges = mediaBadges(it);
  const ends = it.RunTimeTicks ? endsAt((it.RunTimeTicks - (it.UserData?.PlaybackPositionTicks ?? 0)) / TICKS_PER_MS) : null;
  return (
    <div class="hero-meta">
      {it.ProductionYear && <span>{it.ProductionYear}{it.Type === 'Series' && it.Status === 'Continuing' ? '–' : ''}</span>}
      {it.OfficialRating && <span class="badge">{it.OfficialRating}</span>}
      {!!it.RunTimeTicks && it.Type !== 'Series' && <span>{fmtRuntime(it.RunTimeTicks)}</span>}
      {it.Type === 'Series' && it.ChildCount ? <span>{it.ChildCount} season{it.ChildCount > 1 ? 's' : ''}</span> : null}
      {it.CommunityRating && (
        <span>
          <Icon name="star" class="star" /> {it.CommunityRating.toFixed(1)}
        </span>
      )}
      {it.CriticRating && <span title="Critic rating">Critics {it.CriticRating}%</span>}
      {badges.length > 0 && (
        <span class="badges">
          {badges.map((b) => (
            <span key={b} class={'badge' + (b === '4K' || b.startsWith('HDR') || b === 'Dolby Vision' ? ' solid' : '')}>{b}</span>
          ))}
        </span>
      )}
      {ends && it.Type !== 'Series' && <span class="muted">Ends at {ends}</span>}
    </div>
  );
}

/** Movie / episode header with action buttons. */
function Head({ it, active, onChanged, playTarget, seasonId }: { it: Item; active: boolean; onChanged: () => void; playTarget?: Item | null; seasonId?: string }) {
  const target = playTarget ?? it;
  const pos = target.UserData?.PlaybackPositionTicks ?? 0;
  const resumable = pos > 0 && !target.UserData?.Played;
  const isEp = it.Type === 'Episode';
  const logo = logoUrl(it);
  const title = isEp ? it.SeriesName ?? it.Name : it.Name;
  const [, force] = useState(0);

  // X = play from anywhere on the page (spec a2).
  useEffect(() => {
    if (!active) return;
    return pushHandler((e) => {
      if (e.action === 'x' && !e.repeat) {
        playItem(target);
        return true;
      }
      if (e.action === 'menu' && !e.repeat && !current()?.dataset.item) {
        contextMenu(target, onChanged);
        return true;
      }
      return false;
    });
  }, [active, target.Id]);

  const tracks = () => {
    const all = streams(target);
    const auds = all.filter((s) => s.Type === 'Audio');
    const subs = all.filter((s) => s.Type === 'Subtitle');
    const sel = pickTracks(target);
    openPicker(
      [
        {
          title: 'Audio',
          icon: 'audio',
          options: auds.map((s) => ({ label: audioLabel(s), value: String(s.Index), selected: s.Index === sel.audio })),
          onPick: (v) => rememberAudio(target, all, +v),
        },
        {
          title: 'Subtitles',
          icon: 'subtitles',
          options: [
            { label: 'Off', value: '-1', selected: sel.sub === -1 },
            ...subs.map((s) => ({ label: subLabel(s), value: String(s.Index), sub: s.IsExternal ? 'External' : s.Codec?.toUpperCase(), selected: s.Index === sel.sub })),
            ...((target.Type === 'Episode' || target.Type === 'Movie') && caps.value?.subtitleTools !== false ? [{ label: 'Find subtitles…', value: 'find', action: true, icon: 'findSubs' as const }] : []),
            ...(it.Type === 'Series' && caps.value?.subtitleTools !== false ? [{ label: 'Download for season or series…', value: 'bulk', action: true, icon: 'downloads' as const }] : []),
          ],
          onPick: (v) => {
            if (v === 'bulk') return openSeriesSubs(it, seasonId);
            if (v === 'find') {
              openFinder({
                item: target,
                onDownloaded: (idx) => {
                  if (idx !== null) getItem(target.Id).then((f) => rememberSub(target, streams(f), idx)).catch(() => {});
                  onChanged(); // re-fetch so the new track shows in Audio & Subtitles
                },
              });
              return;
            }
            rememberSub(target, all, +v);
          },
        },
      ],
      false,
    );
  };

  const toggle = async (kind: 'played' | 'fav') => {
    try {
      if (kind === 'played') {
        const v = !it.UserData?.Played;
        it.UserData = { ...it.UserData, ...(await setPlayed(it.Id, v)) };
        showToast(v ? 'Marked as watched' : 'Marked as unwatched');
      } else {
        const v = !it.UserData?.IsFavorite;
        it.UserData = { ...it.UserData, ...(await setFavorite(it.Id, v)) };
        showToast(v ? 'Added to favorites' : 'Removed from favorites');
      }
      force((n) => n + 1);
      onChanged();
    } catch (e) {
      log('toggle failed', kind, String(e));
      showToast('Action failed');
    }
  };

  const hasTracks = streams(target).some((s) => s.Type === 'Audio' || s.Type === 'Subtitle');
  return (
    <div class="detail-head" data-scrolltop>
      {logo ? <img class="detail-logo fade-swap" src={logo} alt={title} /> : <div class="detail-title fade-swap">{title}</div>}
      {isEp && (
        <div class="detail-sub">
          {episodeLabel(it)} · {it.Name}
        </div>
      )}
      <MetaLine it={it} />
      {it.Genres?.length ? <div class="detail-genres">{it.Genres.join(' · ')}</div> : null}
      {it.Overview && <div class="detail-overview">{it.Overview}</div>}
      <div class="btn-row" data-group="actions">
        <div class="btn focusable" tabIndex={-1} data-autofocus data-fkey="act-play" onClick={() => playItem(target)}>
          <Icon name="play" fill />
          {playTarget && playTarget !== it ? (resumable ? `Resume ${episodeLabel(target)}` : `Play ${episodeLabel(target)}`) : resumable ? 'Resume' : 'Play'}
        </div>
        {resumable && (
          <div class="btn focusable" tabIndex={-1} onClick={() => playItem(target, true)}>
            <Icon name="restart" /> Restart
          </div>
        )}
        {target.Type !== 'Series' && hasTracks && (
          <div class="btn focusable" tabIndex={-1} onClick={tracks}>
            <Icon name="subtitles" />
            Audio & Subtitles
          </div>
        )}
        <div class={'btn icon focusable' + (it.UserData?.Played ? ' on' : '')} tabIndex={-1} onClick={() => toggle('played')} title={it.UserData?.Played ? 'Watched' : 'Mark watched'} aria-label="Watched">
          <Icon name="watched" />
        </div>
        <div class={'btn icon focusable' + (it.UserData?.IsFavorite ? ' on' : '')} tabIndex={-1} onClick={() => toggle('fav')} title="Favorite" aria-label="Favorite">
          <Icon name="heart" class="ico-heart" />
        </div>
        {isEp && it.SeriesId && (
          <div class="btn focusable" tabIndex={-1} onClick={() => push({ name: 'item', id: it.SeriesId!, seasonId: it.SeasonId })}>
            <Icon name="shows" />
            Go to Series
          </div>
        )}
      </div>
      {resumable && !!target.RunTimeTicks && (
        <div class="resume-note">
          {fmtClock(pos / TICKS_PER_MS)} of {fmtClock(target.RunTimeTicks / TICKS_PER_MS)} watched
        </div>
      )}
    </div>
  );
}

function Extras({ it }: { it: Item }) {
  const { data: sim } = useAsync(() => similar(it.Id), [it.Id]);
  const tmdb = Number((it as Item & { ProviderIds?: Record<string, string> }).ProviderIds?.Tmdb) || null;
  const { x, ready } = useTmdbExtras(it.Type === 'Series' ? 'tv' : 'movie', tmdb);
  const cast = (it.People ?? []).filter((p) => p.Type === 'Actor').slice(0, 14);
  return (
    <>
      {cast.length > 0 && (
        <section class="row" data-group={'cast-' + it.Id} data-scrollunit>
          <h2 class="row-title">Cast</h2>
          <div class="row-viewport" data-hscroll>
            <div class="row-track people">
              {cast.map((p) => (
                <PersonCard key={p.Id} fkey={'cast-' + p.Id} p={{ name: p.Name, role: p.Role, jfId: p.Id, imageTag: p.PrimaryImageTag }} />
              ))}
            </div>
          </div>
        </section>
      )}
      <SameWorldRow x={x} gid={it.Id} />
      <MoreLikeThis it={it} sim={sim} x={x} ready={ready} />
    </>
  );
}

function SeriesBody({ series, active, initialSeason, rev, onChanged }: { series: Item; active: boolean; initialSeason?: string; rev: number; onChanged: () => void }) {
  const { data: ss } = useAsync(() => seasons(series.Id), [series.Id, rev]);
  const { data: nu, error: nuErr } = useAsync(() => seriesNextUp(series.Id), [series.Id, rev]);
  const [seasonId, setSeasonId] = useState<string | undefined>(initialSeason);
  const next = nu?.Items[0] ?? null;

  // Wait for Next Up too: picking as soon as the seasons arrive chose Season 1, and the up-next episode was never in the row.
  useEffect(() => {
    if (seasonId || !ss || (!nu && !nuErr)) return;
    const fromNext = next?.SeasonId && ss.Items.find((s) => s.Id === next.SeasonId);
    setSeasonId((fromNext || ss.Items.find((s) => (s.IndexNumber ?? 0) > 0) || ss.Items[0])?.Id);
  }, [ss, nu, nuErr]);

  const { data: eps } = useAsync(() => (seasonId ? episodes(series.Id, seasonId) : Promise.resolve(null)), [seasonId, rev]);

  // D-pad Down from the buttons enters the season row on the SELECTED season (the up-next one), not the nearest pill (S1).
  useEffect(() => {
    if (!seasonId) return;
    const id = requestAnimationFrame(() => {
      const pill = document.querySelector<HTMLElement>(`[data-fkey="season-${seasonId}"]`);
      if (pill && document.activeElement !== pill) remember(pill);
    });
    return () => cancelAnimationFrame(id);
  }, [seasonId, ss]);

  const [busy, setBusy] = useState<string | null>(null);
  const togglePlayed = async (s: Item) => {
    if (busy) return;
    const played = !!s.UserData?.Played;
    setBusy(s.Id);
    try {
      const ud = await setPlayed(s.Id, !played);
      s.UserData = { ...s.UserData, ...ud };
      showToast(`${s.Name}: ${played ? 'marked as unwatched' : 'marked as watched'}`);
      log('season played', s.Name, !played);
      onChanged();
    } catch (err) {
      log('season played failed', String(err));
      showToast('Action failed');
    } finally {
      setBusy(null);
    }
  };

  // LB / RB = previous / next season. X on a season pill = mark the season watched / unwatched.
  useEffect(() => {
    if (!active || !ss) return;
    return pushHandler((e) => {
      if (e.action === 'x' && !e.repeat) {
        const el = current();
        const s = el?.dataset.fkey?.startsWith('season-') ? ss.Items.find((x) => 'season-' + x.Id === el.dataset.fkey) : undefined;
        if (!s) return false;
        togglePlayed(s);
        return true;
      }
      if ((e.action === 'lb' || e.action === 'rb') && !e.repeat) {
        const i = ss.Items.findIndex((s) => s.Id === seasonId);
        const n = i + (e.action === 'rb' ? 1 : -1);
        if (n >= 0 && n < ss.Items.length) {
          setSeasonId(ss.Items[n].Id);
          requestAnimationFrame(() => focusEl(document.querySelector<HTMLElement>(`[data-fkey="season-${ss.Items[n].Id}"]`)));
        }
        return true;
      }
      return false;
    });
  }, [active, ss, seasonId, busy]);

  // When the season changes, keep the season row focused but scroll episodes to the next-up episode.
  const epRow = useRef<HTMLDivElement>(null);

  // series head uses next-up episode as play target; fetch its full item for streams
  const { data: nextFull } = useAsync(() => (next ? getItem(next.Id) : Promise.resolve(null)), [next?.Id]);

  return (
    <>
      <Head it={series} active={active} onChanged={onChanged} playTarget={nextFull ?? next ?? null} seasonId={seasonId} />
      {ss && ss.Items.length > 0 && (
        <div class="season-tabs" data-group="seasons" data-scrollunit>
          {ss.Items.map((s) => {
            const played = !!s.UserData?.Played;
            return (
              <div
                key={s.Id}
                class={'pill focusable season-pill' + (s.Id === seasonId ? ' selected' : '') + (played ? ' played' : '')}
                tabIndex={-1}
                data-fkey={'season-' + s.Id}
                title={played ? 'Watched' : undefined}
                onFocus={() => setSeasonId(s.Id)}
                onClick={() => {
                  setSeasonId(s.Id);
                  const first = epRow.current?.querySelector<HTMLElement>('.focusable');
                  if (first) focusEl(first);
                }}
              >
                <span
                  class={'season-check' + (busy === s.Id ? ' busy' : '')}
                  role="checkbox"
                  aria-checked={played}
                  title={played ? 'Mark as unwatched' : 'Mark as watched'}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayed(s);
                  }}
                >
                  <Icon name={busy === s.Id ? 'busy' : played ? 'watched' : 'unwatched'} />
                </span>
                {s.Name}
              </div>
            );
          })}
        </div>
      )}
      {ss && ss.Items.length > 0 && (
        <div class={'season-hint' + (focusedKey.value?.startsWith('season-') ? ' on' : '')}>
          <span class="season-hint-key">X</span>
          {ss.Items.find((x) => 'season-' + x.Id === focusedKey.value)?.UserData?.Played ? 'Mark season as unwatched' : 'Mark season as watched'}
        </div>
      )}
      <div ref={epRow}>
        {eps && (
          <Row title={`${eps.Items.length} Episodes`} id={'eps-' + seasonId} kind="thumb">
            {eps.Items.map((e) => (
              <EpisodeCard key={e.Id} ep={e} isNext={e.Id === next?.Id} />
            ))}
          </Row>
        )}
      </div>
      <Extras it={series} />
    </>
  );
}

function EpisodeCard({ ep, isNext }: { ep: Item; isNext: boolean }) {
  return (
    <div class="ep-card-wrap">
      <Card
        item={ep}
        kind="thumb"
        fkey={'ep-' + ep.Id}
        title={`${ep.IndexNumber ?? ''}. ${ep.Name}`}
        subtitle={[fmtRuntime(ep.RunTimeTicks), isNext ? 'Up next' : ''].filter(Boolean).join(' · ')}
        autofocus={isNext}
        onSelect={() => playItem(ep)}
        extra={ep.Overview && <div class="ep-overview">{ep.Overview}</div>}
      />
    </div>
  );
}

export { thumbUrl };
