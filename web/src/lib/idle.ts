// App-wide "is anybody there?" clock for the Still-watching check (components/StillWatching.tsx).
// Any user input anywhere in the app resets it: keys (keyboard + WebView2 controller keyCodes 195-218), mouse, touch, wheel,
// and everything that goes through lib/input.ts dispatch() (Gamepad API, native B, remote debug keys) via lastInputAt().
import { signal } from '@preact/signals';
import { lastInputAt } from './input';
import { settings } from './settings';

/** True while the "Are you still watching?" prompt is up: Player's own key handler / focus repairs stand back. */
export const stillWatching = signal(false);

// Wall clock (not performance.now): idle time must keep counting across a WebView freeze.
let lastActivity = Date.now();
let lastDispatch = lastInputAt();
export const markActive = () => (lastActivity = Date.now());

const on = (t: string, f: (e: any) => void) => window.addEventListener(t, f, { capture: true, passive: true });
on('keydown', markActive);
on('keyup', markActive);
on('pointerdown', markActive);
on('mousedown', markActive);
on('touchstart', markActive);
on('wheel', markActive);
let mx = -1, my = -1;
on('mousemove', (e: MouseEvent) => {
  // Chrome sends synthetic mousemoves at the same spot when layout changes under a resting cursor: only real moves count.
  if (Math.abs(e.clientX - mx) + Math.abs(e.clientY - my) < 2) return;
  mx = e.clientX;
  my = e.clientY;
  markActive();
});

/** Debug: `?idletest=20` = 20 s limit (forces the check on, whatever Settings says). */
const testSec = Number(new URLSearchParams(location.search).get('idletest')) || 0;

/** Idle limit in ms; 0 = check off. */
export function idleLimitMs() {
  if (testSec > 0) return testSec * 1000;
  return Math.max(0, settings.value.stillWatchingMin ?? 60) * 60_000;
}

export function idleMs() {
  // dispatch() timestamps are performance.now(): convert the newest one to wall-clock time.
  const d = lastInputAt();
  if (d !== lastDispatch) {
    lastDispatch = d;
    lastActivity = Math.max(lastActivity, Date.now() - (performance.now() - d));
  }
  return Date.now() - lastActivity;
}

(window as any).__idle = { idleMs, idleLimitMs, reset: markActive, open: () => stillWatching.value };
