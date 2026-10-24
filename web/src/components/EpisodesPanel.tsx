// In-player side panel: every season/episode of the show, watched state, current episode highlighted.
// LB/RB (or the season pills) switch season, A plays an episode in place, B / Menu closes.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Img } from './Img';
import { Item, seasons, episodes, thumbUrl, progressPct, fmtRuntime } from '../lib/jellyfin';
import { pushHandler } from '../lib/input';
import { current, focusEl, focusFirst, move } from '../lib/focus';
import { log } from '../lib/log';

export function EpisodesPanel({ ep, onPick, onClose }: { ep: Item; onPick: (e: Item) => void; onClose: () => void }) {
  const [ss, setSs] = useState<Item[] | null>(null);
  const [seasonId, setSeasonId] = useState<string | undefined>(ep.SeasonId);
  const [eps, setEps] = useState<Item[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!ep.SeriesId) return;
    seasons(ep.SeriesId)
      .then((r) => {
        setSs(r.Items);
        if (!r.Items.some((s) => s.Id === seasonId)) setSeasonId(r.Items[0]?.Id);
      })
      .catch((e) => log('episodes panel: seasons failed', String(e)));
  }, [ep.SeriesId]);

  useEffect(() => {
    if (!ep.SeriesId || !seasonId) return;
    let off = false;
    setEps(null);
    episodes(ep.SeriesId, seasonId)
      .then((r) => !off && setEps(r.Items))
      .catch((e) => log('episodes panel: episodes failed', String(e)));
    return () => {
      off = true;
    };
  }, [seasonId]);

  // Focus: the playing episode on first open, else the first episode of the season (keeps the season pill when switching via LB/RB).
  useEffect(() => {
    if (!eps) return;
    requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      if (firstLoad.current) {
        firstLoad.current = false;
        const cur = root.querySelector<HTMLElement>('.epp-item.now') ?? root.querySelector<HTMLElement>('.epp-item');
        if (!focusEl(cur, { instant: true })) focusFirst(root);
      } else if (!current() || !root.contains(current())) focusFirst(root.querySelector('.epp-list'));
    });
  }, [eps]);

  const step = (d: 1 | -1) => {
    if (!ss) return;
    const i = ss.findIndex((s) => s.Id === seasonId);
    const n = i + d;
    if (n < 0 || n >= ss.length) return;
    setSeasonId(ss[n].Id);
    requestAnimationFrame(() => focusEl(ref.current?.querySelector<HTMLElement>(`[data-fkey="epp-s-${ss[n].Id}"]`)));
  };

  useEffect(
    () =>
      pushHandler((e) => {
        const a = e.action;
        if (a === 'back' || a === 'menu' || a === 'view') {
          if (!e.repeat) onClose();
          return true;
        }
        if (a === 'lb' || a === 'rb') {
          if (!e.repeat) step(a === 'rb' ? 1 : -1);
          return true;
        }
        if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
          move(a);
          return true;
        }
        if (a === 'select') {
          if (!e.repeat) current()?.click();
          return true;
        }
        return true; // panel is modal: swallow X/Y/triggers
      }),
    [ss, seasonId],
  );

  const seasonName = ss?.find((s) => s.Id === seasonId)?.Name ?? '';
  return (
    <div class="epp-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside class="epp" data-scope ref={ref}>
        <div class="epp-head">
          <div class="epp-series">{ep.SeriesName}</div>
          <div class="epp-hint">LB / RB to change season</div>
        </div>
        {ss && ss.length > 1 && (
          <div class="epp-seasons" data-group="epp-seasons" data-hscroll>
            <div class="epp-seasons-track">
              {ss.map((s) => (
                <div
                  key={s.Id}
                  class={'pill focusable' + (s.Id === seasonId ? ' selected' : '')}
                  tabIndex={-1}
                  data-fkey={'epp-s-' + s.Id}
                  onClick={() => setSeasonId(s.Id)}
                >
                  {s.Name}
                </div>
              ))}
            </div>
          </div>
        )}
        {ss && ss.length <= 1 && <div class="epp-season-name">{seasonName}</div>}
        <div class="epp-list" data-vscroll data-margintop="2rem" data-marginbottom="2rem" data-group="epp-list">
          <div class="vtrack">
            {!eps &&
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} class="epp-item sk-row">
                  <div class="epp-art sk" />
                  <div class="epp-body">
                    <div class="sk" style={{ width: '60%', height: '1.2rem' }} />
                  </div>
                </div>
              ))}
            {eps?.map((x) => {
              const now = x.Id === ep.Id;
              const played = !!x.UserData?.Played;
              const pct = progressPct(x);
              return (
                <div
                  key={x.Id}
                  class={'epp-item focusable' + (now ? ' now' : '') + (played ? ' played' : '')}
                  tabIndex={-1}
                  data-fkey={'epp-' + x.Id}
                  onClick={() => (now ? onClose() : onPick(x))}
                >
                  <div class="epp-art">
                    <Img src={thumbUrl(x, 400)} alt="" />
                    {pct > 0 && pct < 100 && !played && (
                      <div class="progress">
                        <i style={{ transform: `scaleX(${pct / 100})` }} />
                      </div>
                    )}
                    {now && <div class="epp-now">Now Playing</div>}
                  </div>
                  <div class="epp-body">
                    <div class="epp-title">
                      <span class="epp-num">{x.IndexNumber ?? ''}</span>
                      {x.Name}
                    </div>
                    <div class="epp-meta">
                      {played ? <span class="epp-watched">Watched</span> : pct > 0 ? <span>{Math.round(pct)}% watched</span> : null}
                      {x.RunTimeTicks ? <span>{fmtRuntime(x.RunTimeTicks)}</span> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
