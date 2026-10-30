// Picture-in-picture: the playing session keeps running in a small window while the rest of the app is used.
//
// State lives in lib/router.ts (`playback` = the session the mounted Player is keyed by, `pip`); this module adds the
// helpers, the capability check, the global Menu intercept and the bridge rect calls. Rules:
//  - Full screen = a `player` route on the stack. PiP = no player route; the Player stays mounted (App renders it from
//    `playback`, not from the route) and draws components/PipWindow.tsx instead of its overlay.
//  - Enter: Menu in the full-screen player (or its PiP button). Entering pops the player route (focus returns to the
//    card that started playback). Menu (any page) or a click on the window pushes the player route again for the SAME
//    session (no restart).
//  - Starting other playback while in PiP (Play / Resume / card A / X / episode / remote playId) is a new session: the
//    old Player unmounts (stop + reportStopped with its position) and the new one opens full screen. Same item = full screen.
//  - playerActive (router) = FULL-SCREEN player only: clock, phone-remote typing, MobileChrome. playbackActive = also PiP:
//    reload deferral (lib/wake.ts, lib/renderprobe.ts) and View -> Dash (switching sides reloads the WebView = kills video).
//  - Player keys are unbound in PiP: the Player's handlers return false and everything goes to the app, except Menu.
//  - Video: native (Xbox) moves the MediaPlayerElement above the WebView to the window's rect (bridge `setVideoRect`,
//    capability `pip`); the browser mock bridge positions #mock-video the same way. rect null = full screen behind the UI.
//
// Transitions. The page under the video only ever switches (player <-> browsing) while the video covers the whole
// screen ABOVE the page, so the switch itself is never seen:
//  - enter: raise the video at full size (raiseVideoFull, looks unchanged) -> pop the player route -> PipWindow's first
//    rect moves it into the window;
//  - leave: move it to full size above the page (pipFullScreen) -> push the player route -> once the transparent player
//    page has painted, drop it behind (videoBehind).
// The move animates only where the shell animates it (capability `pipSubs`, and the browser mock). Older shells resize
// the native video on every message, so stepping it from here stutters: there the moves are instant.
import { capabilities, isNative, onNative, send } from './bridge';
import { setInterceptor } from './input';
import { dialog } from '../components/Dialog';
import { log } from './log';
import { closePlayback, enterPip, pip, playback, push } from './router';
import { auth } from './jellyfin';
import { effect, signal } from '@preact/signals';

export { pip, playback, enterPip, closePlayback };

/** Older shells without setVideoRect can't show the native video in a window: no PiP button there. */
export const pipSupported = () => !isNative || capabilities.pip === true;

/** Shell draws the PiP subtitle line (`setPipSubs`) and animates `setVideoRect {anim}` (both shell 0.2+ / browser). */
export const pipSubsSupported = () => !isNative || capabilities.pipSubs === true;
const animates = () => pipSubsSupported() && !document.documentElement.classList.contains('reduce-motion');
/** Length of the shell's move animation (VideoRect.cs PipAnimMs, bridge mock). */
export const PIP_ANIM_MS = 360;

/** Going back to full screen: the video is growing, PipWindow fades its frame out and stops sending subtitles. */
export const pipLeaving = signal(false);

type R = { x: number; y: number; w: number; h: number };
/** What the shell was last told (page CSS px; null = full screen behind the UI; undefined = unknown, e.g. after a reload). */
let shown: R | null | undefined;
let shownRadius = 0;
let seq = 0; // cancels a deferred videoBehind
const fullRect = (): R => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
const isFull = (r: R | null | undefined) => !!r && r.x <= 0 && r.y <= 0 && r.w >= innerWidth && r.h >= innerHeight;
const same = (a: R | null | undefined, b: R | null) => a !== undefined && (a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h));

function sendRect(rect: R | null, radius = 0, anim = false) {
  seq++;
  radius = Math.round(radius);
  // Repeats (the ResizeObserver's first callback, a dialog closing) would stop a running move: skip them.
  if (same(shown, rect) && (!rect || radius === shownRadius)) return;
  anim = anim && animates();
  send(rect ? { type: 'setVideoRect', rect, vw: innerWidth, vh: innerHeight, radius, anim } : { type: 'setVideoRect', rect: null, anim });
  shown = rect;
  shownRadius = radius;
}

/** Rect of the PiP video box in CSS px of this page (null = full screen, behind the UI). anim = move from where it is now. */
export function sendVideoRect(el: HTMLElement | null, radiusPx = 0, anim = false) {
  if (!el) return sendRect(null, 0, anim);
  const b = el.getBoundingClientRect();
  sendRect({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }, radiusPx, anim);
}

/** Resolves on the shell's `videoRect` ack (or after 250 ms). */
function acked(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      off();
      clearTimeout(t);
      resolve();
    };
    const off = onNative((m) => m.type === 'videoRect' && finish());
    const t = setTimeout(finish, 250);
  });
}

/** Entering PiP, step 1: the video above the UI at full size (looks unchanged), so the page can switch under it. */
export function raiseVideoFull(): Promise<void> {
  const ack = acked();
  sendRect(fullRect());
  return ack;
}

/**
 * PipWindow unmounted. sameSession = back to full screen of the same playback (else it closed or other playback started).
 * Raised at full size already (pipFullScreen): drop it behind once the transparent player page has painted, so the
 * browsing page under it is never seen. Otherwise (e.g. Play on the same item from a card) move it back right away.
 */
export function videoBehind(sameSession: boolean) {
  if (!sameSession || !isFull(shown)) return sendRect(null, 0, sameSession);
  const t = ++seq;
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => t === seq && sendRect(null), 60)));
}

/** PiP -> full screen, same session: grow the video over the page, then switch the page to the player under it. */
export function pipFullScreen(why: string) {
  const s = playback.peek();
  if (!pip.peek() || !s || pipLeaving.peek()) return;
  log('pip: full screen', why);
  pipLeaving.value = true;
  sendPipSubs('');
  const anim = animates();
  const ack = acked();
  sendRect(fullRect(), 0, anim);
  const go = () => {
    const cur = playback.peek();
    // Closed / replaced meanwhile: PipWindow (or its unmount) puts the video back.
    if (pip.peek() && cur && cur.key === s.key) push({ name: 'player', id: s.id });
    pipLeaving.value = false;
  };
  if (anim) setTimeout(go, PIP_ANIM_MS);
  else void ack.then(go);
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
  if (pipLeaving.peek()) text = '';
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
