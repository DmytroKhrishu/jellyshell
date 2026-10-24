// Xbox: after a long suspend the WebView sometimes comes back with its GPU raster state gone: every text glyph is blank,
// some layers never repaint, and the backdrop shows striped garbage (seen on the console; restarting the app fixes it).
// The page itself is fine, only its rendering is lost, so a reload is the cheap, reliable cure. Auth lives in localStorage.
//
// Suspend detection doesn't rely on visibilitychange (UWP suspend doesn't always deliver it to the WebView): a 1 s ticker
// that suddenly sees a big wall-clock gap means the process was frozen.
import { isXbox } from './mode';
import { playerActive } from './router';
import { log } from './log';

const LONG_SLEEP_MS = 10 * 60_000;
const TICK_MS = 1000;

let last = Date.now();
let hiddenAt = 0;
let pending = false;

function reload(why: string, gapMs: number) {
  if (playerActive.value) {
    // Never yank a running player; reload as soon as the user leaves it.
    if (!pending) log('wake: reload deferred (player)', why, Math.round(gapMs / 1000) + 's');
    pending = true;
    return;
  }
  log('wake: reload after long sleep', why, Math.round(gapMs / 1000) + 's');
  // Give the log line a moment to flush.
  setTimeout(() => location.reload(), 300);
}

if (isXbox) {
  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > LONG_SLEEP_MS) reload('timer-gap', gap);
  }, TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LONG_SLEEP_MS) reload('visible', Date.now() - hiddenAt);
  });

  playerActive.subscribe((on) => {
    if (!on && pending) reload('after-player', 0);
  });
}
