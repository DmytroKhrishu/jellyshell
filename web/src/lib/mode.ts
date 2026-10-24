// UI mode: 10-foot TV (Xbox / big non-touch screens), desktop (mouse + keyboard), or mobile (touch / narrow).
// Sets html.mode-tv | html.mode-desktop | html.mode-mobile (+ html.touch while the last input was a finger),
// so styles and behaviour can branch. Mobile = native scrolling, no focus rings, tap = activate.
import { signal } from '@preact/signals';
import { isNative } from './bridge';

export type UiMode = 'tv' | 'desktop' | 'mobile';
export type Modality = 'touch' | 'mouse' | 'keys';

const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
const params = new URLSearchParams(location.search);
const forced = params.get('mode') as UiMode | null; // ?mode=mobile|desktop|tv (testing)
const forceTouch = params.get('touch') === '1'; // ?touch=1: treat every pointer as a finger (preview testing)

export const isXbox = isNative || /Xbox|Windows\.Xbox/i.test(navigator.userAgent);
/** iPadOS Safari pretends to be a Mac; touch points give it away. */
export const isIPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isIOS = /iPhone|iPod/.test(navigator.userAgent) || isIPad;
export const isAndroid = /Android/i.test(navigator.userAgent);
/** The Android TV / Google TV wrapper APK (android/) tags its WebView UA with JellyShellTV/<ver>. Remote = D-pad arrows + Enter + Escape (Back). */
export const isAndroidTV = /JellyShellTV\//.test(navigator.userAgent);

export function detectMode(): UiMode {
  if (forced === 'tv' || forced === 'desktop' || forced === 'mobile') return forced;
  if (isXbox || isAndroidTV) return 'tv';
  const coarse = mq('(pointer: coarse)') && mq('(hover: none)');
  const touchDevice = coarse || isIOS || isAndroid || forceTouch;
  // Big screen, no touch, no fine pointer (TV browsers, remotes): 10-foot.
  if (!touchDevice && navigator.maxTouchPoints === 0 && !mq('(any-pointer: fine)') && innerWidth >= 1280) return 'tv';
  if (touchDevice || innerWidth <= 900) return 'mobile';
  return 'desktop';
}

export const uiMode = signal<UiMode>(detectMode());
export const isMobile = () => uiMode.value === 'mobile';
export const modality = signal<Modality>(uiMode.value === 'mobile' && (forceTouch || mq('(pointer: coarse)')) ? 'touch' : uiMode.value === 'tv' ? 'keys' : 'mouse');

const root = document.documentElement;
function applyClasses() {
  root.classList.remove('mode-tv', 'mode-desktop', 'mode-mobile');
  root.classList.add('mode-' + uiMode.value);
  root.classList.toggle('touch', modality.value === 'touch');
}
applyClasses();

if (!isXbox && !isAndroidTV) {
  let raf = 0;
  const re = () => {
    raf = 0;
    const m = detectMode();
    if (m !== uiMode.value) {
      uiMode.value = m;
      applyClasses();
    }
  };
  addEventListener('resize', () => void (raf ||= requestAnimationFrame(re)), { passive: true });
  addEventListener('orientationchange', re, { passive: true });
}

// ---------------- input modality ----------------
let lastTouch = -1e9;
export const recentTouch = () => forceTouch || performance.now() - lastTouch < 900;
function setModality(m: Modality) {
  if (modality.value !== m) {
    modality.value = m;
    applyClasses();
  }
}
if (!isXbox) {
  const touched = () => {
    lastTouch = performance.now();
    setModality('touch');
  };
  addEventListener('touchstart', touched, { capture: true, passive: true });
  addEventListener('touchend', touched, { capture: true, passive: true });
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen' || forceTouch) touched();
      else setModality('mouse');
    },
    { capture: true, passive: true },
  );
  // Compatibility mouse events after a tap must not count as "mouse": no hover-focus, no player overlay wake.
  addEventListener(
    'mousemove',
    (e) => {
      if (recentTouch()) e.stopImmediatePropagation();
      else if (modality.value === 'touch' && (e.movementX || e.movementY)) setModality('mouse');
    },
    { capture: true },
  );
  addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // typing on the phone keyboard
      setModality('keys');
    },
    { capture: true },
  );
}

const TEXT = 'input, textarea, select, label, [contenteditable]';

if (!isXbox) {
  // Mobile + finger: a tap must not move focus (no focus ring, no focus-driven side effects). Click still fires.
  addEventListener(
    'mousedown',
    (e) => {
      if (uiMode.value !== 'mobile' || !recentTouch()) return;
      const t = e.target as Element | null;
      if (t?.closest?.(TEXT)) return;
      if (t?.closest?.('.focusable')) e.preventDefault();
    },
    { capture: true },
  );
  // Programmatic focus (initial focus, dialogs) while on touch: drop it again so no ring shows.
  document.addEventListener('focusin', (e) => {
    if (uiMode.value !== 'mobile' || modality.value !== 'touch') return;
    const t = e.target as HTMLElement;
    if (t?.classList?.contains('focusable') && !t.matches(TEXT) && !t.querySelector('input:focus')) t.blur();
  });
}

/** Native scrolling replaces the transform-based scrollers on mobile: bring `el` into view the native way. */
export function nativeReveal(el: HTMLElement) {
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}
