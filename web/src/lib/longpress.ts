// Long press → context menu, for every item card (Continue Watching, Next Up, posters, episodes).
//  Controller / keyboard: A held ≥ 500 ms (A tap still plays/opens). Menu (≡) opens it at once (App.tsx).
//  Mouse: right-click. Touch / pen: press and hold ≥ 500 ms (the click that follows is swallowed).
import { itemFromEl, contextMenu } from './actions';
import { onRelease, ActionEvent } from './input';
import { focusEl } from './focus';
import { log } from './log';

export const LONG_PRESS_MS = 500;

let armed: { el: HTMLElement; since: number; timer: number; fallback: number } | null = null;
/** Set once a real key/pad release of A was seen: from then on the 500 ms timer alone decides "held". */
let releaseSeen = false;

function openFor(el: HTMLElement, how: string) {
  const it = itemFromEl(el);
  if (!it) return false;
  if (document.activeElement !== el) focusEl(el, { noReveal: true });
  el.classList.remove('lp-hold');
  log('context menu', how, it.Name);
  contextMenu(it);
  return true;
}

function disarm() {
  if (!armed) return;
  window.clearTimeout(armed.timer);
  window.clearTimeout(armed.fallback);
  armed.el.classList.remove('lp-hold');
  armed = null;
}

/** A pressed on a card: wait for release (tap → click) or a hold (→ menu). */
export function armLongPress(el: HTMLElement) {
  disarm();
  el.classList.add('lp-hold');
  const a = {
    el,
    since: performance.now(),
    timer: window.setTimeout(() => {
      if (armed === a && releaseSeen) {
        disarm();
        openFor(el, 'hold A');
      }
    }, LONG_PRESS_MS),
    // No release ever arrived and no repeats either (a platform that drops keyup): treat it as a tap.
    fallback: window.setTimeout(() => {
      if (armed === a) {
        disarm();
        el.click();
      }
    }, 1500),
  };
  armed = a;
}

/** Key auto-repeat of A while armed: a hold, even before we've ever seen a keyup. */
export function longPressRepeat(e: ActionEvent) {
  if (!armed || e.action !== 'select' || !e.repeat) return false;
  if (e.heldMs >= LONG_PRESS_MS - 50) {
    const el = armed.el;
    disarm();
    openFor(el, 'hold A (repeat)');
  }
  return true;
}

export function installLongPress() {
  onRelease((a) => {
    if (a !== 'select') return;
    releaseSeen = true;
    if (!armed) return;
    const el = armed.el;
    disarm();
    el.click();
  });

  // ---- pointer: right-click, touch long-press ----
  let press: { el: HTMLElement; x: number; y: number; timer: number } | null = null;
  let swallowClickUntil = 0;
  const cardAt = (t: EventTarget | null) => {
    const el = (t as Element | null)?.closest?.<HTMLElement>('.card[data-item]');
    return el && itemFromEl(el) ? el : null;
  };
  const cancel = () => {
    if (!press) return;
    window.clearTimeout(press.timer);
    press.el.classList.remove('lp-hold');
    press = null;
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse uses right-click
    const el = cardAt(e.target);
    if (!el) return;
    cancel();
    el.classList.add('lp-hold');
    const p = {
      el,
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        if (press !== p) return;
        press = null;
        swallowClickUntil = performance.now() + 800;
        openFor(el, 'touch hold');
      }, LONG_PRESS_MS),
    };
    press = p;
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) cancel();
  }, { passive: true });
  document.addEventListener('pointerup', cancel, { passive: true });
  document.addEventListener('pointercancel', cancel, { passive: true });
  document.addEventListener('click', (e) => {
    if (performance.now() < swallowClickUntil && cardAt(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      swallowClickUntil = 0;
    }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    const el = cardAt(e.target);
    if (!el) return;
    e.preventDefault();
    if (performance.now() < swallowClickUntil) return; // touch hold already opened it
    cancel();
    openFor(el, 'right-click');
  });
}
