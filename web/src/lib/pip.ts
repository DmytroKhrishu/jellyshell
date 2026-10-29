// Picture-in-picture: the playing session keeps running in a small window while the rest of the app is used.
//
// State lives in lib/router.ts (`playback` = the session the mounted Player is keyed by, `pip`); this module adds the
// helpers, the capability check, the global Menu intercept and the bridge rect call. Rules:
//  - Full screen = a `player` route on the stack. PiP = no player route; the Player stays mounted (App renders it from
//    `playback`, not from the route) and draws components/PipWindow.tsx instead of its overlay.
//  - Entering PiP pops the player route (focus returns to the card that started playback). Menu (any page) or a click
//    on the window pushes the player route again for the SAME session (no restart).
//  - Starting other playback while in PiP (Play / Resume / card A / X / episode / remote playId) is a new session: the
//    old Player unmounts (stop + reportStopped with its position) and the new one opens full screen. Same item = full screen.
//  - playerActive (router) = FULL-SCREEN player only: clock, phone-remote typing, MobileChrome. playbackActive = also PiP:
//    reload deferral (lib/wake.ts, lib/renderprobe.ts) and View -> Dash (switching sides reloads the WebView = kills video).
//  - Player keys are unbound in PiP: the Player's handlers return false and everything goes to the app, except Menu.
//  - Video: native (Xbox) moves the MediaPlayerElement above the WebView to the window's rect (bridge `setVideoRect`,
//    capability `pip`); the browser mock bridge positions #mock-video the same way. rect null = full screen behind the UI.
import { capabilities, isNative, send } from './bridge';
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

/** Rect of the PiP video box in CSS px of this page (null = full screen, behind the UI). */
export function sendVideoRect(el: HTMLElement | null, radiusPx = 0) {
  if (!el) {
    send({ type: 'setVideoRect', rect: null });
    return;
  }
  const b = el.getBoundingClientRect();
  send({
    type: 'setVideoRect',
    rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
    vw: innerWidth,
    vh: innerHeight,
    radius: Math.round(radiusPx),
  });
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
