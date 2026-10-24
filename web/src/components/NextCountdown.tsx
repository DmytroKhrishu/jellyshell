// Next Episode card + countdown (Settings → Next episode autoplay, settings.nextAutoplay):
//   N > 0 : when the card appears at the credits, count N s down (a fill on the Play Next button + "Next episode in N"), then
//           advance. Counts only while the video plays (pause = countdown paused) and no dialog/panel/prompt is up.
//           Any player input other than A cancels the countdown (the card stays; the file end still autoplays as before);
//           B dismisses the card. A on the card plays at once.
//   -1    : "End of credits": no countdown, the next episode starts when the file ends (the old behaviour).
//   0     : Off: the card offers the next episode but nothing starts by itself; the file end leaves the player.
// The countdown only runs where advancing early can't cut content (lib/introskip.ts nextTiming `clean`: a detected Outro that
// runs to the end of the file). Without one (fallback card 40 s before the end, a scene after the credits) it waits for the end.
// Advancing goes through the caller's `advance`, which asks the Still-watching boundary check first.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Item, episodeLabel, fmtClock, thumbUrl } from '../lib/jellyfin';
import { settings } from '../lib/settings';
import { log } from '../lib/log';
import { Img } from './Img';
import { Icon } from './icons';
import '../styles/autoskip.css';

export const NEXT_AUTOPLAY: [number, string][] = [[0, 'Off'], [5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s'], [-1, 'End of credits']];
export const nextAutoplayMode = () => settings.value.nextAutoplay ?? 5;

export interface CountdownOpts {
  visible: boolean;
  /** Advancing before the file end is safe (credits run to the end). */
  clean: boolean;
  playing: boolean;
  /** Something modal is up (dialog, finder, episodes panel, still-watching): hold the clock. */
  blocked: () => boolean;
  advance: () => void;
}

export function useNextCountdown(o: CountdownOpts) {
  const opts = useRef(o);
  opts.current = o;
  const secs = nextAutoplayMode();
  const enabled = secs > 0 && o.clean;
  const total = secs * 1000;
  const [left, setLeft] = useState(total);
  const [cancelled, setCancelled] = useState(false);
  const s = useRef({ left: total, fired: false, cancelled: false, last: 0 });

  // Fresh countdown every time the card (re)appears.
  useEffect(() => {
    s.current = { left: total, fired: false, cancelled: false, last: performance.now() };
    setLeft(total);
    setCancelled(false);
  }, [o.visible, total]);

  useEffect(() => {
    if (!o.visible || !enabled) return;
    const t = window.setInterval(() => {
      const c = s.current;
      const now = performance.now();
      const dt = now - c.last;
      c.last = now;
      const p = opts.current;
      if (c.fired || c.cancelled || !p.playing || p.blocked()) return;
      c.left = Math.max(0, c.left - dt);
      setLeft(c.left);
      if (c.left <= 0) {
        c.fired = true;
        log('next countdown: advance', { secs });
        p.advance();
      }
    }, 200);
    return () => window.clearInterval(t);
  }, [o.visible, enabled]);

  const cancel = () => {
    const c = s.current;
    if (!opts.current.visible || !enabled || c.cancelled || c.fired) return;
    c.cancelled = true;
    setCancelled(true);
    log('next countdown: cancelled', { leftMs: Math.round(c.left) });
  };

  const counting = o.visible && enabled && !cancelled;
  return { counting, leftMs: left, progress: counting ? 1 - left / total : null, cancel };
}

export function NextCard({ next, label, progress, onPlay }: { next: Item; label: string; progress: number | null; onPlay: () => void }) {
  return (
    <div class="next-card">
      <div class="art">
        <Img src={thumbUrl(next, 640)} alt={next.Name} />
      </div>
      <div class="body">
        <div class="lbl">{label}</div>
        <div class="nm">
          {episodeLabel(next)} · {next.Name}
        </div>
        <div class={'btn focusable nc-btn' + (progress !== null ? ' counting' : '')} tabIndex={-1} data-fkey="next-play" onClick={onPlay}>
          {progress !== null && <i class="nc-fill" style={{ transform: `scaleX(${progress})` }} />}
          <Icon name="play" fill /> Play Next
        </div>
      </div>
    </div>
  );
}

/** Card label for the current mode/state. */
export function nextLabel(cd: { counting: boolean; leftMs: number }, untilEndMs: number) {
  if (cd.counting) return `Next episode in ${Math.max(1, Math.ceil(cd.leftMs / 1000))}`;
  if (nextAutoplayMode() === 0) return 'Next episode'; // nothing starts by itself
  return `Next episode · in ${fmtClock(untilEndMs)}`; // starts when the file ends
}
