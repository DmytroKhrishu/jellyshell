// Movies: a calm "More Like This" shelf that slides up from the bottom while the end credits roll (Apple TV / Netflix style).
// Timing + content come from lib/upnext-movie.ts (creditsTiming / relatedForPlayer). Episodes never get it (they have Next).
//
// Keys (wired by pages/Player.tsx through `handle`, which runs after the dialog / finder / still-watching checks):
//  - Overlay hidden: Down enters the shelf (remembered card, else the first), Up leaves it (back to the credits), Left/Right
//    move between cards, A plays a movie at once / opens a series' page, X opens a movie's details, B hides the shelf.
//  - Overlay visible: the shelf sits above the controls and spatial D-pad reaches it from the seek bar; B in the shelf hides it.
//  - B on a shelf that isn't focused (overlay hidden) also hides it, like the episode Next card.
// Nobody touches anything: the credits play on and the file end leaves the player as before (no autoplay of a random film).
// Hidden = hidden for this playback (seeking back to the credits doesn't bring it back). A post-credits scene hides it.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { Item, progressPct, thumbUrl } from '../lib/jellyfin';
import { Segment } from '../lib/playback';
import { ActionEvent } from '../lib/input';
import { current, focusEl, move, restoreIn } from '../lib/focus';
import { creditsTiming, relatedForPlayer, ShelfItem } from '../lib/upnext-movie';
import { settings } from '../lib/settings';
import { log } from '../lib/log';
import { Img } from './Img';
import { Icon } from './icons';
import { SItem, tmdbImg } from '../lib/seerr';
import '../styles/creditsshelf.css';

/** Start loading the related titles this long before the shelf is due. */
const PREFETCH_MS = 3 * 60_000;

export interface CreditsShelfOpts {
  item: Item | null;
  segments: Segment[];
  /** Item runtime from RunTimeTicks (segment times are file times). */
  runtimeMs: number;
  posMs: number;
  /** Something else owns the bottom right now (a skip prompt, a scrub preview with the overlay hidden). */
  suppressed: boolean;
  root: RefObject<HTMLElement>;
  /** A on a card: play the movie (details=false) or open its page. */
  open: (it: Item, details: boolean) => void;
  /** A on a TMDB-only title (not in the library): open its TMDB page. */
  openTmdb: (it: SItem) => void;
}

export function useCreditsShelf(o: CreditsShelfOpts) {
  const on = settings.value.creditsShelf !== false;
  const timing = useMemo(() => (on ? creditsTiming(o.item, o.segments, o.runtimeMs) : null), [on, o.item, o.segments, o.runtimeMs]);
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const loading = useRef(false);

  const due = !!timing && o.posMs >= timing.at - PREFETCH_MS;
  useEffect(() => {
    if (!due || !o.item || loading.current) return;
    loading.current = true;
    relatedForPlayer(o.item)
      .then(setItems)
      .catch((e) => (log('credits shelf: related failed', String(e?.message ?? e)), setItems([])));
  }, [due, o.item?.Id]);

  const inCredits = !!timing && o.posMs >= timing.at && (timing.until === null || o.posMs < timing.until);
  const visible = inCredits && !dismissed && !!items?.length && !o.suppressed;

  const logged = useRef('');
  useEffect(() => {
    const k = visible ? 'show' : logged.current === 'show' && timing?.until != null && o.posMs >= timing.until ? 'scene' : '';
    if (k && logged.current !== k) {
      logged.current = k;
      log('credits shelf: ' + k, { item: o.item?.Name, source: timing?.source, atS: Math.round((timing?.at ?? 0) / 1000), untilS: timing?.until ? Math.round(timing.until / 1000) : null, items: items?.length });
    }
  }, [visible]);

  // Hidden while focus was inside: give focus back to the player (or nothing, with the overlay hidden).
  useEffect(() => {
    if (visible) return;
    const cur = document.activeElement as HTMLElement | null;
    if (cur?.closest('.cshelf')) {
      const ui = o.root.current?.classList.contains('ui');
      if (ui) focusEl(o.root.current?.querySelector<HTMLElement>('.pp-play'));
      else cur.blur();
    }
  }, [visible]);

  const shelfEl = () => o.root.current?.querySelector<HTMLElement>('.cshelf');
  const inShelf = () => !!current()?.closest('.cshelf');
  const dismiss = (ui: boolean) => {
    const was = inShelf();
    setDismissed(true);
    log('credits shelf: dismissed', { item: o.item?.Name });
    if (was) {
      if (ui) focusEl(o.root.current?.querySelector<HTMLElement>('.pp-play'));
      else (document.activeElement as HTMLElement | null)?.blur?.();
    }
  };
  const pick = (s: ShelfItem, details: boolean) => {
    log('credits shelf: open', { from: o.item?.Name, to: s.item?.Name ?? s.tmdb?.title ?? s.tmdb?.name, type: s.item?.Type ?? 'tmdb-' + s.tmdb?.mediaType, why: s.why, details });
    if (s.item) o.open(s.item, details);
    else if (s.tmdb) o.openTmdb(s.tmdb);
  };

  /** Player key hook. true = consumed. */
  const handle = (e: ActionEvent, ui: boolean): boolean => {
    if (!visible) return false;
    const a = e.action;
    const here = inShelf();
    switch (a) {
      case 'back':
        if (e.repeat) return false;
        if (here || !ui) {
          dismiss(ui);
          return true;
        }
        return false;
      case 'down':
        if (ui) return false;
        if (!here) restoreIn(shelfEl()?.querySelector('[data-group]'));
        return true;
      case 'up':
        if (!here || ui) return false;
        (document.activeElement as HTMLElement | null)?.blur?.();
        return true;
      case 'left':
      case 'right':
        if (!here) return false;
        move(a);
        return true;
      case 'select':
        if (!here || e.repeat) return here;
        current()?.click();
        return true;
      case 'x': {
        if (!here) return false;
        if (e.repeat) return true;
        const id = current()?.dataset.fkey?.slice(3);
        const s = items?.find((x) => x.key === id);
        if (s) pick(s, true);
        return true;
      }
    }
    return false;
  };

  const node =
    timing && items?.length ? (
      <div class={'cshelf' + (visible ? ' on' : '')} aria-hidden={!visible}>
        <div class="cshelf-shade" />
        <div class="cshelf-head">
          <h2 class="cshelf-title">More Like This</h2>
          <div class="cshelf-hint cs-hint-enter">
            <Icon name="chevDown" /> Browse
          </div>
          <div class="cshelf-hint cs-hint-in">
            <span class="cshelf-key">X</span> Details
            <span class="cshelf-key cshelf-key-b">B</span> Hide
          </div>
        </div>
        <div class="row-viewport" data-hscroll data-group="cshelf">
          <div class="row-track">
            {items.map((s) => (
              <ShelfCard key={s.key} s={s} onPick={() => pick(s, false)} onDetails={() => pick(s, true)} />
            ))}
          </div>
        </div>
      </div>
    ) : null;

  return { visible, handle, node, timing };
}

function ShelfCard({ s, onPick, onDetails }: { s: ShelfItem; onPick: () => void; onDetails: () => void }) {
  if (!s.item) return <TmdbShelfCard s={s} t={s.tmdb!} onPick={onPick} />;
  const it = s.item;
  const pct = progressPct(it);
  const played = it.UserData?.Played;
  const sub = s.note ?? (it.Type === 'Series' ? 'Series' + (it.ProductionYear ? ' · ' + it.ProductionYear : '') : it.ProductionYear ? String(it.ProductionYear) : '');
  // No data-item: the app-wide card shortcuts (long-press menu, X = play) must not fire inside the player.
  return (
    <div class={'card thumb focusable cs-card' + (s.why === 'collection-next' ? ' cs-next' : '')} tabIndex={-1} data-fkey={'cs-' + s.key} onClick={onPick}
      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), onDetails())}>
      <div class="card-art">
        <Img src={thumbUrl(it, 520)} alt={it.Name} />
        {pct > 0 && pct < 100 && !played && (
          <div class="progress">
            <i style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        )}
        {played && (
          <div class="badge-check" aria-label="watched">
            <Icon name="check" stroke={3} />
          </div>
        )}
        <div class="cs-play" aria-hidden="true">
          <Icon name={it.Type === 'Series' ? 'info' : 'play'} fill={it.Type !== 'Series'} />
        </div>
      </div>
      <div class="card-text">
        <div class="card-title">{it.Name}</div>
        {sub && <div class="card-sub">{sub}</div>}
      </div>
    </div>
  );
}

/** A franchise title that isn't in the library (e.g. the TV spin-off of a movie): TMDB backdrop, A opens its TMDB page. */
function TmdbShelfCard({ s, t, onPick }: { s: ShelfItem; t: SItem; onPick: () => void }) {
  const title = t.title ?? t.name ?? '';
  return (
    <div class="card thumb focusable cs-card cs-tmdb" tabIndex={-1} data-fkey={'cs-' + s.key} onClick={onPick} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), onPick())}>
      <div class="card-art">
        <Img src={tmdbImg(t.backdropPath, 'w780') ?? tmdbImg(t.posterPath, 'w500')} alt={title} />
        <div class="cs-play" aria-hidden="true">
          <Icon name="info" />
        </div>
      </div>
      <div class="card-text">
        <div class="card-title">{title}</div>
        {s.note && <div class="card-sub">{s.note}</div>}
      </div>
    </div>
  );
}
