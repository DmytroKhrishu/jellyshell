// Picture-in-picture: the playing session keeps running in a small window while the rest of the app is used.
//
// State lives in lib/router.ts (`playback` = the session the mounted Player is keyed by, `pip`); this module adds the
// helpers, the capability check, the global Menu intercept and the bridge rect call. Rules:
//  - Full screen = a `player` route on the stack. PiP = no player route; the Player stays mounted (App renders it from
//    `playback`, not from the route) and draws components/PipWindow.tsx instead of its overlay.
//  - Enter: the player's PiP button or Menu in the full-screen player. Entering PiP pops the player route (focus returns to the card that started playback). Menu (any page) or a click
//    on the window pushes the player route again for the SAME session (no restart).
//  - Starting other playback while in PiP (Play / Resume / card A / X / episode / remote playId) is a new session: the
//    old Player unmounts (stop + reportStopped with its position) and the new one opens full screen. Same item = full screen.
//  - playerActive (router) = FULL-SCREEN player only: clock, phone-remote typing, MobileChrome. playbackActive = also PiP:
//    reload deferral (lib/wake.ts, lib/renderprobe.ts) and View -> Dash (switching sides reloads the WebView = kills video).
//  - Player keys are unbound in PiP: the Player's handlers return false and everything goes to the app, except Menu.
//  - Video: native (Xbox) moves the MediaPlayerElement above the WebView to the window's rect (bridge `setVideoRect`,
//    capability `pip`); the browser mock bridge positions #mock-video the same way. rect null = full screen behind the UI.
import { capabilities, isNative, onNative, send } from './bridge';
import { setInterceptor } from './input';
import { dialog } from '../components/Dialog';
import { log } from './log';
import { closePlayback, enterPip, pip, playback, push } from './router';
import { auth } from './jellyfin';
import { effect } from '@preact/signals';

export { pip, playback, enterPip, closePlayback };

/** Older shells without setVideoRect can't show the native video in a window: no PiP button there. */
export const pipSupported = () => !isNative || capabilities.pip === true;

/** PiP -> full screen, same session. */
export function pipFullScreen(why: string) {
  const s = playback.peek();
  if (!pip.peek() || !s) return;
  log('pip: full screen', why);
  push({ name: 'player', id: s.id });
}

/** Shell draws the PiP subtitle line and animates the video between full screen and the window. */
export const pipSubsSupported = () => !isNative || capabilities.pipSubs === true;

type R = { x: number; y: number; w: number; h: number };
const ANIM_MS = 360;
/** Where the video is drawn now (page CSS px; null = full screen behind the UI) and its corner radius. */
let shown: R | null = null;
let shownRadius = 0;
let stepRaf = 0;
const fullRect = (): R => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
const raw = (rect: R | null, radius: number, extra: Record<string, unknown> = {}) =>
  send(rect ? { type: 'setVideoRect', rect, vw: innerWidth, vh: innerHeight, radius: Math.round(radius), ...extra } : { type: 'setVideoRect', rect: null, ...extra });

/**
 * Shells without `pipSubs` don't animate `setVideoRect`: step it from the page instead (a rect per frame, eased).
 * Leaving (to = null) steps up to full size above the UI, then sends null (behind the UI).
 */
function stepRect(to: R | null, toRadius: number) {
  const from = shown ?? fullRect();
  const fromRadius = shown ? shownRadius : 0;
  const end = to ?? fullRect();
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
  const tick = () => {
    const k = ease(Math.min(1, (performance.now() - t0) / ANIM_MS));
    if (k >= 1) {
      stepRaf = 0;
      raw(to, toRadius, { step: true });
      return;
    }
    raw({ x: lerp(from.x, end.x, k), y: lerp(from.y, end.y, k), w: lerp(from.w, end.w, k), h: lerp(from.h, end.h, k) }, fromRadius + (toRadius - fromRadius) * k, { step: true });
    stepRaf = requestAnimationFrame(tick);
  };
  tick();
}

/** Rect of the PiP video box in CSS px of this page (null = full screen, behind the UI). anim = ease from where it is now. */
export function sendVideoRect(el: HTMLElement | null, radiusPx = 0, anim = false) {
  cancelAnimationFrame(stepRaf);
  stepRaf = 0;
  let rect: R | null = null;
  if (el) {
    const b = el.getBoundingClientRect();
    rect = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  }
  const reduce = document.documentElement.classList.contains('reduce-motion');
  if (anim && !reduce && isNative && !pipSubsSupported()) stepRect(rect, radiusPx);
  else raw(rect, radiusPx, { anim: anim && !reduce });
  shown = rect;
  shownRadius = radiusPx;
}

/**
 * Entering PiP, step 1: raise the video above the UI at full size (looks the same as now), wait for the ack, so the
 * page swapping to opaque under it is never seen. Step 2 is PipWindow's first rect, sent with anim (shrink into the corner).
 */
export function raiseVideoFull(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off();
      clearTimeout(t);
      resolve();
    };
    const off = onNative((m) => m.type === 'videoRect' && finish());
    const t = setTimeout(finish, 250);
    sendVideoRect({ getBoundingClientRect: () => ({ left: 0, top: 0, width: innerWidth, height: innerHeight }) } as unknown as HTMLElement, 0);
  });
}

/** Cue HTML (<i>, <b>, <font>…, entities) -> plain text. <template> parses inertly (no scripts, no image loads). */
export function cueText(html: string) {
  const t = document.createElement('template');
  t.innerHTML = html.replace(/<br\s*\/?>/gi, '\n');
  return (t.content.textContent ?? '').trim();
}

/** Current subtitle line for the PiP window (the shell draws it over the raised video). '' = none. */
let lastSubs = '';
export function sendPipSubs(text: string) {
  if (text === lastSubs || !pipSubsSupported()) return;
  lastSubs = text;
  send({ type: 'setPipSubs', text });
}

// Menu while PiP is up = back to full screen, on any page (it never opens the card context menu then).
setInterceptor((e) => {
  if (e.action !== 'menu' || !pip.value || !playback.value) return false;
  if (!e.repeat && !dialog.value) pipFullScreen('menu');
  return true;
});

// Signed out (or switched user) while PiP was up: the session must not resume under the next login.
effect(() => {
  if (auth.value || !playback.peek()) return;
  log('pip: closed on sign-out');
  pip.value = false;
  playback.value = null;
});
