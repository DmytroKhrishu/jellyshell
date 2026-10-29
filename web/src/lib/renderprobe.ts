// Xbox: catch the "text / icons vanish" render loss while it happens, instead of guessing when it happens.
//
// Symptom (photos from the TV): every text glyph and every SVG icon is blank, while images and plain boxes (button
// backgrounds, focus rings, borders) still draw. Restarting the app cures it. It is NOT tied to a long suspend: on
// 2026-10-29 it showed ~1 min after a cold launch, so lib/wake.ts (reload after a suspend gap) can't catch it alone.
// Text and vector paths are rasterized by the WebView's GPU raster path; images and solid rects are not, so this probe
// draws exactly those three things on a fresh 2D canvas and reads the pixels back:
//   rect ok + text or path blank  =>  raster path broken (the bug)  =>  log it, then reload once (deferred while playing).
// The reload result is logged on the next boot ("ok after reload" vs "still broken"), which tells us whether a page
// reload is enough or the WebView process itself has to restart.
// A new, large canvas every probe: Chromium keeps small canvases in software and drops a canvas to software after repeated
// getImageData, either of which would hide the bug. Desktop test: ?probetest=1 (probe on), ?probetest=broken (fake a hit).
import { isXbox } from './mode';
import { playbackActive } from './router'; // full screen OR picture-in-picture: never reload under a playing video
import { log } from './log';

const EVERY_MS = 15_000;
const FIRST_MS = 4_000;
const KEY = 'jellyshell.renderprobe';
/** At most this many automatic reloads per window, so a reload that doesn't cure it can't loop. */
const MAX_RELOADS = 2;
const WINDOW_MS = 10 * 60_000;

interface Probe {
  text: number;
  path: number;
  rect: number;
}

function lit(ctx: CanvasRenderingContext2D, x: number, w: number, h: number) {
  const d = ctx.getImageData(x, 0, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
  return n;
}

function probe(): Probe | null {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.font = '600 40px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('Hg', 4, 8);
  // A stroked curve, like the Lucide icons that vanish (filled boxes and plain circles kept drawing on the TV).
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(90, 50);
  ctx.bezierCurveTo(100, 0, 140, 0, 150, 30);
  ctx.lineTo(120, 52);
  ctx.stroke();
  ctx.fillRect(180, 10, 40, 40);
  const p = { text: lit(ctx, 0, 80, 60), path: lit(ctx, 80, 80, 60), rect: lit(ctx, 160, 80, 60) };
  if (fake) p.text = p.path = 0;
  return p;
}

interface State {
  reloads: number[];
  lastBroken?: number;
}
const load = (): State => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '') as State;
  } catch {
    return { reloads: [] };
  }
};
const save = (s: State) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
};

const t0 = Date.now();
const fake = /[?&]probetest=broken/.test(location.search);
let broken = false;
let pending = false;
let first = true;
let gaveUp = false;

function gpuInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : gl ? 'webgl' : 'no-webgl';
  } catch {
    return 'err';
  }
}

function recover(p: Probe) {
  if (playbackActive.value) {
    if (!pending) log('render probe: reload deferred (player)');
    pending = true;
    return;
  }
  pending = false;
  const s = load();
  const now = Date.now();
  s.reloads = (s.reloads ?? []).filter((t) => now - t < WINDOW_MS);
  if (s.reloads.length >= MAX_RELOADS) {
    if (!gaveUp) log('render probe: reload limit reached, app restart needed', p);
    gaveUp = true;
    return;
  }
  s.reloads.push(now);
  s.lastBroken = now;
  save(s);
  log('render probe: reloading', { ...p, attempt: s.reloads.length });
  setTimeout(() => location.reload(), 300);
}

function check(why: string) {
  let p: Probe | null;
  try {
    p = probe();
  } catch (e) {
    log('render probe: error', String(e));
    return;
  }
  if (!p) return;
  const bad = p.rect > 200 && (p.text < 30 || p.path < 30);
  if (first) {
    first = false;
    const s = load();
    const after = s.lastBroken && Date.now() - s.lastBroken < WINDOW_MS;
    log('render probe: boot', { ...p, ok: !bad, afterReload: !!after, gpu: gpuInfo() });
    if (after && !bad) log('render probe: ok after reload (a page reload cures it)');
    if (after && bad) log('render probe: still broken after reload (needs an app/WebView restart)');
  }
  if (bad && !broken) log('render probe: BROKEN', { ...p, why, uptimeS: Math.round((Date.now() - t0) / 1000), hidden: document.hidden });
  if (!bad && broken) log('render probe: recovered by itself', { ...p, why });
  broken = bad;
  if (bad) recover(p);
}

const forced = /[?&]probetest=(1|broken)/.test(location.search);
if (isXbox || forced) {
  setTimeout(() => check('boot'), FIRST_MS);
  setInterval(() => !document.hidden && check('tick'), EVERY_MS);
  document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(() => check('visible'), 1500));
  playbackActive.subscribe((on) => {
    if (!on && pending) setTimeout(() => check('after-player'), 1500);
  });
}
