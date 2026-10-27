// Lock screen / Control Center controls for what the TV plays (docs/remote.md "Lock screen").
// iOS only shows Now Playing for a page that is actually playing an unmuted media element, so after an explicit tap
// (iOS needs the gesture; it also interrupts the user's own music) we loop a few seconds of real silent audio and hang
// navigator.mediaSession off it. The element's play/pause state IS the lock-screen icon on iOS (WebKit ignores
// mediaSession.playbackState there), so it follows the TV's paused state. Action handlers send relay commands.
import { effect, signal } from '@preact/signals';
import type { PlayerState } from '../lib/remote';
import { keepAwake, send, tv, tvAt } from './api';

export const lockOn = signal(false);
/** Last problem worth telling the user (play() refused, no Media Session). */
export const lockNote = signal('');

const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
export const lockSupported = !!ms;

let el: HTMLAudioElement | null = null;
let blobUrl = '';

/** 8 s of 8 kHz 8-bit mono silence (WAV, ~64 KB, made in memory: no asset, no data: URI blob in the bundle).
 *  Must be > 0.95 s or WebKit treats it as a UI sound and never shows Now Playing. */
function silentWav(seconds = 8, rate = 8000) {
  const n = seconds * rate;
  const b = new DataView(new ArrayBuffer(44 + n));
  const str = (o: number, t: string) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); // PCM
  b.setUint16(22, 1, true); // mono
  b.setUint32(24, rate, true);
  b.setUint32(28, rate, true); // byte rate
  b.setUint16(32, 1, true); // block align
  b.setUint16(34, 8, true); // bits
  str(36, 'data');
  b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128); // 8-bit PCM is unsigned: 128 = silence
  return new Blob([b.buffer], { type: 'audio/wav' });
}

const posNow = (p: PlayerState) => Math.min(p.dur, p.pos + (p.paused || p.buffering ? 0 : performance.now() - tvAt.value));

function setPosition(p: PlayerState) {
  if (!ms?.setPositionState) return;
  try {
    if (p.dur > 0) ms.setPositionState({ duration: p.dur / 1000, position: Math.max(0, posNow(p)) / 1000, playbackRate: p.paused ? 0 : 1 });
  } catch {}
}

let lastMeta = '';
function setMeta(p: PlayerState) {
  if (!ms) return;
  const key = [p.name, p.series, p.sub, p.title, p.art].join('|');
  if (key === lastMeta) return;
  lastMeta = key;
  const MM = (window as any).MediaMetadata;
  if (!MM) return;
  // Episode: "S1:E3 · Name" over the series name; movie: name over the year.
  const art = typeof p.art === 'string' ? [{ src: new URL(p.art, location.href).href, sizes: '600x900', type: 'image/jpeg' }] : [];
  ms.metadata = new MM(p.series ? { title: p.sub || p.name || p.title, artist: p.series, album: '', artwork: art } : { title: p.title, artist: p.sub || '', album: '', artwork: art });
}

const cmd = (o: any) => send({ player: o });
/** A lock-screen play/pause flips the element at once; the TV's state that still says otherwise is stale for a moment. */
let want: { paused: boolean; until: number } | null = null;
function handlers() {
  if (!ms) return;
  const p = () => tv.value?.player;
  const h: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => ((want = { paused: false, until: performance.now() + 4000 }), el?.play().catch(() => {}), (ms.playbackState = 'playing'), cmd({ op: 'play' }))],
    ['pause', () => ((want = { paused: true, until: performance.now() + 4000 }), el?.pause(), (ms.playbackState = 'paused'), cmd({ op: 'pause' }))],
    ['seekbackward', (d) => cmd({ op: 'skip', ms: -Math.round((d.seekOffset ?? (p()?.skipMs ?? 10_000) / 1000) * 1000) })],
    ['seekforward', (d) => cmd({ op: 'skip', ms: Math.round((d.seekOffset ?? (p()?.skipMs ?? 10_000) / 1000) * 1000) })],
    ['seekto', (d) => d.seekTime !== undefined && cmd({ op: 'seek', ms: Math.round(d.seekTime * 1000) })],
    ['nexttrack', () => p()?.next && cmd({ op: 'next' })],
  ];
  for (const [a, f] of h) {
    try {
      ms.setActionHandler(a, f);
    } catch {}
  }
}
function clearSession() {
  if (!ms) return;
  for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'] as MediaSessionAction[]) {
    try {
      ms.setActionHandler(a, null);
    } catch {}
  }
  ms.metadata = null;
  lastMeta = '';
}

/** Follow the TV: element play/pause = lock-screen icon; metadata + position. Called on every TV state. */
let goneTimer = 0;
function sync() {
  const p = tv.value?.player;
  if (!lockOn.value || !el) return;
  if (!p) {
    // Playback on the TV ended. Next Episode / an episode switch drops the player for a moment: give it a grace period.
    if (!goneTimer) goneTimer = window.setTimeout(() => (goneTimer = 0, !tv.value?.player && stopLock()), 12_000);
    if (!el.paused) el.pause();
    return;
  }
  window.clearTimeout(goneTimer);
  goneTimer = 0;
  setMeta(p);
  if (want && (want.paused === p.paused || performance.now() > want.until)) want = null;
  if (want) return; // the TV hasn't caught up with a lock-screen tap yet
  setPosition(p);
  if (ms) ms.playbackState = p.paused ? 'paused' : 'playing';
  if (p.paused && !el.paused) el.pause();
  else if (!p.paused && el.paused) {
    // Resuming without a gesture can be refused (page hidden / locked): keep the session, the lock-screen Play still works.
    el.play().then(() => (lockNote.value = '')).catch(() => (lockNote.value = 'Tap Play here or on the lock screen to resume the controls'));
  }
}

/** Must run inside the tap handler (iOS: audio needs a user gesture). */
export async function startLock() {
  if (!ms) {
    lockNote.value = 'This browser has no lock screen media controls';
    return;
  }
  if (!el) {
    blobUrl = URL.createObjectURL(silentWav());
    el = new Audio();
    el.src = blobUrl;
    el.loop = true; // never fires 'ended' (iOS closes the audio session on a natural end in the background)
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    // iOS re-reads handlers when the element becomes Now Playing, and a loop/seek of the element resets the position
    // to its own currentTime: re-apply both.
    el.addEventListener('playing', () => (handlers(), tv.value?.player && setPosition(tv.value.player)));
    el.addEventListener('seeked', () => tv.value?.player && setPosition(tv.value.player));
  }
  if ('audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'playback';
    } catch {}
  }
  lockOn.value = true;
  keepAwake.value = true;
  lockNote.value = '';
  handlers();
  const p = tv.value?.player;
  try {
    await el.play();
    if (p?.paused && lockOn.value) el?.pause(); // started by the gesture (unlocks later play()), then mirror the TV
  } catch (e) {
    // AbortError = a pause (TV paused, lock-screen Pause) landed before playback started: harmless.
    const name = String((e as Error)?.name ?? e);
    if (name === 'AbortError') return;
    stopLock();
    lockNote.value = 'Could not start the lock screen controls (' + name + ')';
    return;
  }
  sync();
}

export function stopLock() {
  want = null;
  window.clearTimeout(goneTimer);
  goneTimer = 0;
  lockOn.value = false;
  keepAwake.value = false;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
    el = null;
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = '';
  clearSession();
  if ('audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'auto';
    } catch {}
  }
}

effect(() => {
  void tv.value;
  sync();
});
// The lock screen extrapolates from position + rate; refresh it now and then so drift (buffering on the TV) stays small.
window.setInterval(() => lockOn.value && tv.value?.player && setPosition(tv.value.player), 15_000);
