// InputRouter: keyboard / Xbox WebView2 keyCodes / Gamepad API / native 'back' / remote debug -> semantic actions.
import { log } from './log';
import { isNative, onNative } from './bridge';
import { focusEl, scopeRoot, wheelScroll } from './focus';

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'select' | 'back' | 'x' | 'y'
  | 'lb' | 'rb' | 'lt' | 'rt'
  | 'menu' | 'view';

export interface ActionEvent {
  action: Action;
  repeat: boolean; // auto-repeat while held
  source: 'key' | 'pad' | 'native' | 'remote';
  heldMs: number; // how long the physical button has been held (0 on first press)
}

/** Handler returns true when it consumed the action. Handlers are tried top (last pushed) first. */
export type Handler = (e: ActionEvent) => boolean | void;
export type ReleaseHandler = (a: Action) => void;

const handlers: Handler[] = [];
const releaseHandlers = new Set<ReleaseHandler>();

export function pushHandler(h: Handler) {
  handlers.push(h);
  return () => {
    const i = handlers.lastIndexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}
export function onRelease(h: ReleaseHandler) {
  releaseHandlers.add(h);
  return () => releaseHandlers.delete(h);
}

// Xbox WebView2 keyCodes (verified on device) + keyboard fallbacks for desktop testing.
const XBOX: Record<number, Action> = {
  195: 'select', 196: 'back', 197: 'x', 198: 'y', 199: 'rb', 200: 'lb', 201: 'lt', 202: 'rt',
  203: 'up', 204: 'down', 205: 'left', 206: 'right', 207: 'menu', 208: 'view',
  211: 'up', 212: 'down', 213: 'left', 214: 'right',
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'select', 27: 'back',
  33: 'lt', 34: 'rt', 93: 'menu', 114: 'y', 8: 'back',
};
const CHARS: Record<string, Action> = { x: 'x', y: 'y', '[': 'lb', ']': 'rb', q: 'lb', e: 'rb', ',': 'lt', '.': 'rt', m: 'menu', v: 'view', '/': 'y', ' ': 'select' };

export const actionForKeyCode = (kc: number) => XBOX[kc];

const downAt = new Map<Action, number>();
let lastAt = 0;
let lastBackKey = 0;
let lastNativeBack = 0;

export function dispatch(action: Action, source: ActionEvent['source'], repeat = false) {
  const now = performance.now();
  if (!repeat) downAt.set(action, now);
  const ev: ActionEvent = { action, repeat, source, heldMs: repeat ? now - (downAt.get(action) ?? now) : 0 };
  lastAt = now;
  for (let i = handlers.length - 1; i >= 0; i--) {
    try {
      if (handlers[i](ev)) return true;
    } catch (e) {
      log('handler error', action, e as Error);
    }
  }
  return false;
}

export const lastInputAt = () => lastAt;

function isTextInput(el: Element | null): el is HTMLInputElement {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// Throttle held-key repeats so a held D-pad moves at a steady ~9 steps/s regardless of OS repeat rate.
const lastRepeat = new Map<Action, number>();
const REPEAT_MS = 110;

document.addEventListener(
  'keydown',
  (e) => {
    const active = document.activeElement;
    let action: Action | undefined = XBOX[e.keyCode];
    if (isTextInput(active)) {
      // Let the text field keep typing keys; Enter is handled by the field itself.
      if (e.keyCode === 37 || e.keyCode === 39 || e.keyCode === 8 || e.keyCode === 32 || e.keyCode === 13) return;
      if (!action) return;
      // Leave the input: focus its focusable wrapper. B just exits editing.
      const wrap = active.closest<HTMLElement>('.focusable');
      wrap?.focus({ preventScroll: true });
      if (action === 'back' || action === 'select') {
        e.preventDefault();
        if (action === 'back') lastBackKey = performance.now();
        return;
      }
    } else if (!action && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      action = CHARS[e.key.toLowerCase()];
    }
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'back') {
      // Same press already delivered as native {type:'back'}: drop the duplicate (repeats still count for hold-B).
      if (!e.repeat && performance.now() - lastNativeBack < 400) return;
      lastBackKey = performance.now();
    }
    if (e.repeat) {
      const now = performance.now();
      if (now - (lastRepeat.get(action) ?? 0) < REPEAT_MS) return;
      lastRepeat.set(action, now);
    }
    dispatch(action, 'key', e.repeat);
  },
  true,
);

document.addEventListener(
  'keyup',
  (e) => {
    const action = XBOX[e.keyCode] ?? (e.key?.length === 1 ? CHARS[e.key.toLowerCase()] : undefined);
    if (!action) return;
    downAt.delete(action);
    for (const h of releaseHandlers) h(action);
  },
  true,
);

// On Xbox, B usually never reaches the page as keydown: UWP turns it into BackRequested and native forwards {type:'back'}.
onNative((m) => {
  if (m.type === 'back') {
    if (performance.now() - lastBackKey < 400) return; // keydown already handled this press
    lastNativeBack = performance.now();
    dispatch('back', 'native');
    for (const h of releaseHandlers) h('back');
  }
});

// Gamepad API — desktop only (on Xbox, keydown already carries every button; polling too would double-fire).
const PAD: Record<number, Action> = { 0: 'select', 1: 'back', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 6: 'lt', 7: 'rt', 8: 'view', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
if (!isNative && 'getGamepads' in navigator) {
  const held = new Map<string, { since: number; last: number }>();
  const poll = () => {
    const now = performance.now();
    for (const p of navigator.getGamepads()) {
      if (!p) continue;
      const pressed = new Map<Action, boolean>();
      p.buttons.forEach((b, i) => PAD[i] && pressed.set(PAD[i], b.pressed || pressed.get(PAD[i]) === true));
      const [ax, ay] = [p.axes[0] ?? 0, p.axes[1] ?? 0];
      if (ax < -0.6) pressed.set('left', true);
      if (ax > 0.6) pressed.set('right', true);
      if (ay < -0.6) pressed.set('up', true);
      if (ay > 0.6) pressed.set('down', true);
      for (const [a, on] of pressed) {
        const k = p.index + a;
        const h = held.get(k);
        if (on && !h) {
          held.set(k, { since: now, last: now });
          dispatch(a, 'pad');
        } else if (on && h && now - h.since > 400 && now - h.last > REPEAT_MS) {
          h.last = now;
          dispatch(a, 'pad', true);
        } else if (!on && h) {
          held.delete(k);
          downAt.delete(a);
          for (const r of releaseHandlers) r(a);
        }
      }
    }
    requestAnimationFrame(poll);
  };
  window.addEventListener('gamepadconnected', (e) => log('gamepad', e.gamepad.id));
  requestAnimationFrame(poll);
}

// ---------- mouse / trackpad (desktop browsers only; the Xbox WebView has no pointer) ----------
/** True while the last focus change came from the pointer: tabs don't switch on hover, nothing auto-scrolls. */
export let pointerFocus = false;
if (!isNative) {
  const root = document.documentElement;
  let lastX = -1, lastY = -1;
  document.addEventListener('mousemove', (e) => {
    if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) < 2) return;
    lastX = e.clientX;
    lastY = e.clientY;
    root.classList.add('mouse');
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('.focusable');
    if (!el || el === document.activeElement || el.closest('.tabbar')) return;
    const scope = scopeRoot();
    if (!scope.contains(el)) return;
    pointerFocus = true;
    focusEl(el, { noReveal: true });
    pointerFocus = false;
  }, { passive: true });
  document.addEventListener('keydown', () => root.classList.remove('mouse'), true);
  document.addEventListener('wheel', (e) => {
    if ((e.target as Element)?.closest?.('input,textarea')) return;
    const px = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1;
    if (wheelScroll(e.target as Element, e.deltaX * px, e.deltaY * px, e.shiftKey)) e.preventDefault();
  }, { passive: false });
  // Back mouse button = B.
  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      dispatch('back', 'key');
    }
  });
}

// ---------- remote debug hook: POST /api/cmd {"key":199} | {"keys":[204,204,195]} | {"action":"select"} ----------
// Several desktop tabs can be open at once (other agents, the user): ?remote=NAME gives a tab its own queue.
const remoteName = isNative ? 'xbox' : new URLSearchParams(location.search).get('remote') || 'browser';
export function startRemote(extra: (cmd: any) => void) {
  const tick = async () => {
    try {
      const r = await fetch('/api/cmd?c=' + encodeURIComponent(remoteName), { cache: 'no-store' });
      const c = await r.json();
      if (c) {
        log('remote cmd', c.auth ? { auth: '<redacted>' } : c);
        const keys: number[] = c.keys ?? (c.key !== undefined ? [c.key] : []);
        for (const k of keys) {
          const a = XBOX[k];
          if (a) {
            dispatch(a, 'remote');
            for (const h of releaseHandlers) h(a);
          }
          await new Promise((res) => setTimeout(res, c.gap ?? 250));
        }
        if (c.action) dispatch(c.action, 'remote');
        extra(c);
      }
    } catch {
      /* server unreachable */
    }
    setTimeout(tick, 1000);
  };
  tick();
}
