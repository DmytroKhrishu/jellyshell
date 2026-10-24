// Audio boost for the browser player (mock bridge, HTML5 <video id=mock-video>): Web Audio graph
//   MediaElementSource → [night: DynamicsCompressor] → Gain (+dB) → limiter (DynamicsCompressor, fast, high ratio) → out
// with AnalyserNodes before and after for measuring (window.__audioBoost.meter()).
// Built lazily on the first non-neutral boost: createMediaElementSource() reroutes the element for good, and an
// AudioContext needs a user gesture to run, so nothing is touched until the user (or a saved setting) asks for it.
// Once built, "Off" sets every stage neutral (gain 1, compressors ratio 1) instead of tearing the graph down.
//
// Not supported where the browser plays HLS natively (Safari / iOS): WebKit gives MediaElementSource silence for
// HLS there, so the option is hidden (see boostSupported()).

export interface Boost {
  db: number; // 0 | 3 | 6 | 10
  night: boolean;
}

interface Graph {
  ctx: AudioContext;
  src: MediaElementAudioSourceNode;
  night: DynamicsCompressorNode;
  gain: GainNode;
  limiter: DynamicsCompressorNode;
  pre: AnalyserNode;
  post: AnalyserNode;
}

let g: Graph | null = null;
let current: Boost = { db: 0, night: false };

const ua = navigator.userAgent;
const safariLike = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg/.test(ua);
const iOS = /iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

/** Web Audio boost works here (false on iOS / Safari, which play HLS natively). */
export function boostSupported() {
  return !!(window.AudioContext || (window as any).webkitAudioContext) && !iOS && !safariLike;
}

const neutral = (b: Boost) => b.db <= 0 && !b.night;

function build(video: HTMLVideoElement): Graph | null {
  try {
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(video);
    const night = ctx.createDynamicsCompressor();
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // Brick-wall-ish limiter just under 0 dBFS so +10 dB doesn't clip.
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const pre = ctx.createAnalyser();
    const post = ctx.createAnalyser();
    pre.fftSize = post.fftSize = 2048;
    src.connect(pre);
    src.connect(night).connect(gain).connect(limiter).connect(ctx.destination);
    limiter.connect(post);
    // A suspended context = silent video: resume on the next input if autoplay rules held it back.
    const kick = () => ctx.state !== 'running' && ctx.resume().catch(() => {});
    ['pointerdown', 'keydown', 'touchend'].forEach((t) => addEventListener(t, kick, { capture: true, passive: true }));
    video.addEventListener('play', kick);
    kick();
    return { ctx, src, night, gain, limiter, pre, post };
  } catch (e) {
    console.warn('audio boost: Web Audio graph failed', e);
    return null;
  }
}

function applyParams(b: Boost) {
  if (!g) return;
  const t = g.ctx.currentTime;
  g.gain.gain.setTargetAtTime(Math.pow(10, Math.max(0, b.db) / 20), t, 0.05);
  // Night mode: squash loud peaks, then the gain stage lifts dialogue. Off = ratio 1 (pass-through).
  g.night.threshold.setValueAtTime(b.night ? -30 : 0, t);
  g.night.knee.setValueAtTime(b.night ? 12 : 0, t);
  g.night.ratio.setValueAtTime(b.night ? 6 : 1, t);
  g.night.attack.setValueAtTime(0.005, t);
  g.night.release.setValueAtTime(0.25, t);
  // Neutral: the limiter steps aside too (threshold 0, ratio 1).
  const off = neutral(b);
  g.limiter.threshold.setValueAtTime(off ? 0 : -1.5, t);
  g.limiter.ratio.setValueAtTime(off ? 1 : 20, t);
}

/** Apply a boost to the mock <video>. Returns what happened, for the bridge ack. */
export function setWebBoost(video: HTMLVideoElement | null, b: Boost): { applied: boolean; reason?: string } {
  current = { db: b.db, night: b.night };
  if (!boostSupported()) return { applied: false, reason: 'unsupported (Safari/iOS native HLS)' };
  if (!g) {
    if (neutral(current)) return { applied: true }; // nothing to do, keep the element untouched
    if (!video) return { applied: false, reason: 'no video yet' };
    g = build(video);
    if (!g) return { applied: false, reason: 'Web Audio unavailable' };
  }
  applyParams(current);
  return { applied: true };
}

export const webBoost = () => current;

function rmsDb(a: AnalyserNode) {
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Debug / verification: RMS (dBFS) before and after the chain, averaged over `ms`. */
async function meter(ms = 1000) {
  if (!g) return { graph: false };
  let pre = 0;
  let post = 0;
  let n = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const a = rmsDb(g.pre);
    const b = rmsDb(g.post);
    if (isFinite(a) && isFinite(b)) {
      pre += a;
      post += b;
      n++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { graph: true, state: g.ctx.state, boost: current, samples: n, preDb: n ? +(pre / n).toFixed(2) : null, postDb: n ? +(post / n).toFixed(2) : null, deltaDb: n ? +((post - pre) / n).toFixed(2) : null };
}

(window as any).__audioBoost = { meter, get: () => current, supported: boostSupported };
