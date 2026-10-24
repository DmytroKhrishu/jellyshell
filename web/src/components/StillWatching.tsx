// Netflix-style "Are you still watching?" for short items (episodes): stops binge autoplay running all night.
//
// Rule (one rule, two placements): playback stops once there has been no user input for the idle limit (Settings, default
// 1 h; lib/idle.ts). If that moment falls close to an episode boundary, it snaps to the boundary instead:
//  - at the boundary (Next Episode autoplay is about to start) with idle >= limit - SNAP -> prompt instead of autoplay;
//  - mid-episode with idle >= limit -> pause at once and prompt, unless the episode ends within SNAP (or the Up Next card is
//    already up), in which case the credits run out and the boundary rule takes it.
// So the prompt lands on the natural break when one is near, and never more than SNAP (<= 10 min) away from the limit itself.
// Items with a runtime of 60 min or more (films) never trigger it.
//
// Keys on the prompt: A / click / Space = Continue watching (resume, or start the next episode at a boundary).
// B = leave the player (position saved), like Netflix's Back and the app's "B is the exit" rule.
// Nobody answers for AUTO_EXIT -> leave the player too: native `stop` releases the DisplayRequest so the console can sleep.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Item, episodeLabel, backdropUrl, thumbUrl, TICKS_PER_MS } from '../lib/jellyfin';
import { idleMs, idleLimitMs, markActive, stillWatching } from '../lib/idle';
import { pushHandler } from '../lib/input';
import { focusEl, move } from '../lib/focus';
import { dialog, closeDialog } from './Dialog';
import { finder } from './SubtitleFinder';
import { log } from '../lib/log';
import { Img } from './Img';
import { Icon } from './icons';
import '../styles/stillwatching.css';

const SHORT_MS = 60 * 60_000;
const q = new URLSearchParams(location.search);
const testSec = Number(q.get('idletest')) || 0;
/** Snap window around the limit; `?idlesnap=SEC` overrides it for tests. */
const snapMs = (limit: number) => (Number(q.get('idlesnap')) ? Number(q.get('idlesnap')) * 1000 : Math.min(10 * 60_000, limit / 6));
/** Unanswered prompt -> leave the player. Test mode: 3 x the test limit. */
const AUTO_EXIT_MS = testSec ? testSec * 3000 : 15 * 60_000;

export interface StillWatchingOpts {
  item: Item | null;
  /** Native duration (fallback when the item has no RunTimeTicks). */
  durMs: number;
  posMs: number;
  playing: boolean;
  /** The Up Next card is showing (credits): wait for the boundary. */
  credits: boolean;
  pause: () => void;
  resume: () => void;
  exit: () => void;
  /** Close player-owned panels (Episodes) before the prompt takes over. */
  closePanels?: () => void;
}

type Prompt = { reason: 'idle' | 'boundary'; cont: () => void; at: number; next?: Item | null };

export function useStillWatching(o: StillWatchingOpts) {
  const opts = useRef(o);
  opts.current = o;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const promptRef = useRef<Prompt | null>(null);
  promptRef.current = prompt;

  const isShort = () => {
    const it = opts.current.item;
    if (!it) return false;
    const run = (it.RunTimeTicks ?? 0) / TICKS_PER_MS || opts.current.durMs;
    return run > 0 && run < SHORT_MS;
  };

  const open = (reason: Prompt['reason'], cont: () => void, next?: Item | null) => {
    const it = opts.current.item;
    const p: Prompt = { reason, cont, at: Date.now(), next };
    promptRef.current = p;
    stillWatching.value = true;
    if (dialog.value) closeDialog();
    if (finder.value) finder.value = null;
    opts.current.closePanels?.();
    log('still watching: prompt', { item: it?.Name, series: it?.SeriesName, id: it?.Id, reason, idleMin: +(idleMs() / 60_000).toFixed(1), limitMin: +(idleLimitMs() / 60_000).toFixed(1), posMs: Math.round(opts.current.posMs) });
    setPrompt(p);
  };

  const close = (how: 'continue' | 'back' | 'timeout') => {
    const p = promptRef.current;
    if (!p) return;
    promptRef.current = null;
    stillWatching.value = false;
    setPrompt(null);
    log('still watching: ' + how, { item: opts.current.item?.Name, reason: p.reason, waitedS: Math.round((Date.now() - p.at) / 1000) });
    if (how === 'continue') {
      markActive();
      p.cont();
    } else opts.current.exit();
  };

  // Mid-episode check.
  useEffect(() => {
    const t = window.setInterval(() => {
      const c = opts.current;
      const p = promptRef.current;
      if (p) {
        if (Date.now() - p.at > AUTO_EXIT_MS) close('timeout');
        return;
      }
      const limit = idleLimitMs();
      if (!limit || !c.playing || !isShort() || idleMs() < limit) return;
      const left = c.durMs > 0 ? c.durMs - c.posMs : Infinity;
      if (c.credits || left <= snapMs(limit)) return; // the boundary is near: let it end there
      c.pause();
      open('idle', () => opts.current.resume());
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => () => void (stillWatching.value = false), []);

  /** At the episode boundary: true = autoplay held, the prompt is up and `next` runs on Continue. */
  const holdNext = (next: () => void, nextItem?: Item | null) => {
    const limit = idleLimitMs();
    if (promptRef.current) return true;
    if (!limit || !isShort() || idleMs() < limit - snapMs(limit)) return false;
    open('boundary', next, nextItem);
    return true;
  };

  const overlay = prompt ? <StillWatchingOverlay item={o.item} next={prompt.next ?? null} boundary={prompt.reason === 'boundary'} onContinue={() => close('continue')} onBack={() => close('back')} /> : null;
  return { holdNext, overlay, open: !!prompt };
}

function StillWatchingOverlay({ item, next, boundary, onContinue, onBack }: { item: Item | null; next: Item | null; boundary: boolean; onContinue: () => void; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLDivElement>(null);
  const cb = useRef({ onContinue, onBack });
  cb.current = { onContinue, onBack };

  useEffect(() => {
    const land = () => {
      const a = document.activeElement;
      if (btn.current && !(a && ref.current?.contains(a))) focusEl(btn.current, { noReveal: true });
    };
    const raf = requestAnimationFrame(land);
    // Keep focus here even if something else repairs focus later (Player's overlay rAFs, async panels).
    const t = window.setInterval(land, 500);
    const off = pushHandler((e) => {
      if (e.repeat) return true;
      if (e.action === 'select') cb.current.onContinue();
      else if (e.action === 'back') cb.current.onBack();
      else if (e.action === 'up' || e.action === 'down' || e.action === 'left' || e.action === 'right') move(e.action);
      return true; // modal: nothing reaches the player underneath
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(t);
      off();
    };
  }, []);

  const bd = item ? backdropUrl(item) || thumbUrl(item, 1280) : '';
  const name = item ? (item.Type === 'Episode' ? item.SeriesName : item.Name) : '';
  // At the boundary, name the episode Continue will start.
  const ep = boundary && next ? next : item;
  const sub = ep?.Type === 'Episode' ? `${episodeLabel(ep)} · ${ep.Name}` : '';
  return (
    <div class="sw-wrap" data-scope ref={ref} onClick={(e) => e.stopPropagation()}>
      {bd && <Img class="sw-bd" src={bd} alt="" />}
      <div class="sw-shade" />
      <div class="sw-body">
        <div class="sw-kicker">{name}</div>
        <h1 class="sw-title">Are you still watching?</h1>
        {sub && <div class="sw-sub">{boundary && next ? 'Up next: ' : ''}{sub}</div>}
        <div class="sw-note">Playback {boundary ? 'stopped' : 'paused'} after a long time with no input.</div>
        <div class="btn focusable sw-btn" tabIndex={-1} data-autofocus data-fkey="sw-continue" ref={btn} onClick={onContinue}>
          <Icon name="play" fill /> Continue watching
        </div>
      </div>
    </div>
  );
}
