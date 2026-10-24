import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/icons';
import { Card, Row, SkeletonRow } from '../components/Card';
import { setBackdrop } from '../components/Backdrop';
import {
  Item, backdropUrl, fmtRuntime, latest, logoUrl, nextUp, resume, episodeLabel, progressPct,
} from '../lib/jellyfin';
import { useAsync } from '../lib/useAsync';
import { useInitialFocus } from '../lib/useInitialFocus';
import { openItem, playItem, playNow, isPlayTile, registerItem } from '../lib/actions';
import { pushHandler } from '../lib/input';
import { current, focusEl, restoreIn } from '../lib/focus';
import { dialog } from '../components/Dialog';

interface HomeData {
  resume: Item[];
  nextUp: Item[];
  movies: Item[];
  shows: Item[];
}

async function loadHome(): Promise<HomeData> {
  const [r, n, m, s] = await Promise.allSettled([resume(), nextUp(), latest('Movie', 24), latest('Series', 24)]);
  const v = <T,>(p: PromiseSettledResult<T>, d: T) => (p.status === 'fulfilled' ? p.value : d);
  const res = v(r, { Items: [], TotalRecordCount: 0 }).Items;
  const resIds = new Set(res.map((i) => i.Id));
  return {
    resume: res,
    nextUp: v(n, { Items: [], TotalRecordCount: 0 }).Items.filter((i) => !resIds.has(i.Id)),
    movies: v(m, [] as Item[]),
    shows: v(s, [] as Item[]),
  };
}

export function Home({ active, refreshKey }: { active: boolean; refreshKey: number }) {
  // Stale-while-revalidate: refetch when data changes anywhere (refreshKey = dataRev) and whenever Home becomes
  // visible again; the old rows stay on screen until the new ones arrive (no skeleton flash).
  const [visits, setVisits] = useState(0);
  const lastLoad = useRef(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && performance.now() - lastLoad.current > 2000) setVisits((v) => v + 1);
    wasActive.current = active;
  }, [active]);
  const { data, loading } = useAsync(() => ((lastLoad.current = performance.now()), loadHome()), [refreshKey, visits]);
  const ref = useRef<HTMLDivElement>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [heroFocused, setHeroFocused] = useState(true);
  useInitialFocus(ref, active, !!data);

  // Remember the focused row + position, so a refresh that removes the focused card lands on its neighbour.
  const lastFocus = useRef<{ group: string; idx: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const f = (e: FocusEvent) => {
      const card = (e.target as HTMLElement).closest?.<HTMLElement>('.card');
      const row = card?.closest<HTMLElement>('.row[data-group]');
      if (!card || !row) return;
      lastFocus.current = { group: row.dataset.group!, idx: Array.from(row.querySelectorAll('.card.focusable')).indexOf(card) };
    };
    el.addEventListener('focusin', f);
    return () => el.removeEventListener('focusin', f);
  }, []);
  useEffect(() => {
    if (!active || !data) return;
    // Two frames: let the route pop restore focus first, then repair it only if it was lost.
    let r2 = 0;
    const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => {
      const root = ref.current;
      const a = document.activeElement as HTMLElement | null;
      if (!root || dialog.value || (a && a !== document.body && a.isConnected)) return; // focus is fine: leave it
      const lf = lastFocus.current;
      const order = ['row-resume', 'row-nextup', 'row-movies', 'row-shows'];
      if (lf) {
        for (const g of order.slice(Math.max(0, order.indexOf(lf.group)))) {
          const cards = root.querySelectorAll<HTMLElement>(`.row[data-group="${g}"] .card.focusable`);
          if (cards.length) {
            focusEl(cards[g === lf.group ? Math.min(lf.idx, cards.length - 1) : 0], { instant: true });
            return;
          }
        }
      }
      restoreIn(root);
    })));
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [data, active]);

  const featured: Item[] = data
    ? dedupe([...data.resume.slice(0, 3), ...data.movies.slice(0, 4), ...data.shows.slice(0, 2)]).filter((i) => backdropUrl(i)).slice(0, 7)
    : [];
  const hero = featured[heroIdx % Math.max(1, featured.length)];

  // Slow auto-rotation while the hero is on screen; paused while one of its buttons has focus (the user is reading).
  const [heroHasFocus, setHeroHasFocus] = useState(false);
  useEffect(() => {
    const f = () => setHeroHasFocus(!!(document.activeElement as HTMLElement | null)?.closest?.('.page.active .hero'));
    document.addEventListener('focusin', f);
    return () => document.removeEventListener('focusin', f);
  }, []);
  useEffect(() => {
    if (!active || !heroFocused || heroHasFocus || featured.length < 2) return;
    const t = window.setInterval(() => setHeroIdx((i) => (i + 1) % featured.length), 9000);
    return () => window.clearInterval(t);
  }, [active, heroFocused, heroHasFocus, featured.length]);

  // D-pad left on the first hero button / right on the last = previous / next slide (wraps).
  useEffect(() => {
    if (!active || featured.length < 2) return;
    return pushHandler((e) => {
      if (e.action !== 'left' && e.action !== 'right') return false;
      const cur = current();
      const row = cur?.closest('.hero .btn-row');
      if (!cur || !row) return false;
      const btns = Array.from(row.querySelectorAll<HTMLElement>('.focusable'));
      const i = btns.indexOf(cur);
      if (e.action === 'left' && i === 0) setHeroIdx((x) => (x - 1 + featured.length) % featured.length);
      else if (e.action === 'right' && i === btns.length - 1) setHeroIdx((x) => (x + 1) % featured.length);
      else return false;
      return true;
    });
  }, [active, featured.length]);

  useEffect(() => {
    if (active && heroFocused && hero) setBackdrop(backdropUrl(hero), 0, 0);
  }, [active, heroFocused, hero?.Id]);

  const onCardFocus = (it: Item) => {
    setHeroFocused(false);
    setBackdrop(backdropUrl(it), 0.45);
  };
  const select = (it: Item) => (isPlayTile(it) ? playItem(it) : openItem(it));

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="9rem" data-marginbottom="7rem" data-group="home">
      <div class="vtrack page-pad">
        {hero ? (
          <Hero
            item={hero}
            count={featured.length}
            idx={heroIdx % featured.length}
            onFocus={() => {
              setHeroFocused(true);
            }}
            onStep={(d) => setHeroIdx((i) => (i + d + featured.length) % featured.length)}
          />
        ) : (
          <div class="hero" />
        )}
        {loading && !data && (
          <>
            <SkeletonRow kind="thumb" count={5} />
            <SkeletonRow />
          </>
        )}
        {data && data.resume.length > 0 && (
          <Row title="Continue Watching" id="row-resume" kind="thumb">
            {data.resume.map((it) => (
              <Card key={it.Id} item={it} kind="thumb" fkey={'resume-' + it.Id} onSelect={select} onFocus={onCardFocus} />
            ))}
          </Row>
        )}
        {data && data.nextUp.length > 0 && (
          <Row title="Next Up" id="row-nextup" kind="thumb">
            {data.nextUp.map((it) => (
              <Card key={it.Id} item={it} kind="thumb" fkey={'next-' + it.Id} onSelect={select} onFocus={onCardFocus} />
            ))}
          </Row>
        )}
        {data && data.movies.length > 0 && (
          <Row title="Latest Movies" id="row-movies">
            {data.movies.map((it) => (
              <Card key={it.Id} item={it} kind="poster" fkey={'lm-' + it.Id} onSelect={(i) => openItem(i)} onFocus={onCardFocus} />
            ))}
          </Row>
        )}
        {data && data.shows.length > 0 && (
          <Row title="Latest Shows" id="row-shows">
            {data.shows.map((it) => (
              <Card key={it.Id} item={it} kind="poster" fkey={'ls-' + it.Id} onSelect={(i) => openItem(i)} onFocus={onCardFocus} />
            ))}
          </Row>
        )}
      </div>
    </div>
  );
}

function dedupe(items: Item[]) {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.SeriesId ?? i.Id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function Hero({ item, count, idx, onFocus, onStep }: { item: Item; count: number; idx: number; onFocus: () => void; onStep: (d: number) => void }) {
  const logo = logoUrl(item);
  registerItem(item);
  const resumable = progressPct(item) > 0;
  const isEp = item.Type === 'Episode';
  const kicker = resumable ? 'Continue Watching' : item.Type === 'Series' ? 'New Episodes' : isEp ? 'Up Next' : 'Recently Added';
  const title = isEp ? item.SeriesName ?? item.Name : item.Name;
  return (
    <div class="hero" data-scrolltop data-group="hero">
      <div class="fade-swap" key={item.Id}>
        <div class="hero-kicker">{kicker}</div>
        {logo ? <img class="hero-logo" src={logo} alt={title} /> : <div class="hero-title">{title}</div>}
        <div class="hero-meta">
          {isEp && <span>{episodeLabel(item)} · {item.Name}</span>}
          {!isEp && item.ProductionYear && <span>{item.ProductionYear}</span>}
          {item.OfficialRating && <span class="badge">{item.OfficialRating}</span>}
          {!!item.RunTimeTicks && <span>{fmtRuntime(item.RunTimeTicks)}</span>}
          {item.CommunityRating && <span><Icon name="star" class="star" /> {item.CommunityRating.toFixed(1)}</span>}
          {item.Genres?.length ? <span>{item.Genres.slice(0, 3).join(', ')}</span> : null}
        </div>
        {item.Overview && <div class="hero-overview">{item.Overview}</div>}
      </div>
      <div class="btn-row" data-block="left right" onFocusCapture={onFocus}>
        <div class="btn focusable" tabIndex={-1} data-autofocus data-item={item.Id} data-fkey="hero-play" onClick={() => playNow(item)}>
          <Icon name="play" fill /> {resumable ? 'Resume' : 'Play'}
        </div>
        <div class="btn focusable" tabIndex={-1} data-item={item.Id} data-fkey="hero-info" onClick={() => openItem(item)}>
          More Info
        </div>
        {count > 1 && (
          <>
            <div class="btn icon focusable hero-arrow hero-prev" tabIndex={-1} data-fkey="hero-prev" onClick={() => onStep(-1)} title="Previous">
              <Icon name="chevLeft" />
            </div>
            <div class="btn icon focusable hero-arrow" tabIndex={-1} data-fkey="hero-next" onClick={() => onStep(1)} title="Next">
              <Icon name="chevRight" />
            </div>
          </>
        )}
      </div>
      {count > 1 && (
        <div class="hero-dots">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} class={i === idx ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}
