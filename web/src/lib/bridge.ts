// Web <-> native bridge (docs/bridge.md v1). Falls back to a mock that plays in an HTML5 <video>.
import Hls from 'hls.js/dist/hls.light.mjs';
import { log } from './log';
import { setWebBoost } from './webaudio';

export interface Capabilities {
  deviceForm?: string;
  hdrDisplay?: boolean;
  video: string[];
  audioNative: string[];
  audioFfmpeg: string[];
  containers: string[];
  maxAudioChannels: number;
  /** Shell understands `setVideoRect` (picture-in-picture). Shells before it omit the flag: no PiP button. */
  pip?: boolean;
  /** Shell draws PiP subtitles (`setPipSubs`) and animates `setVideoRect {anim:true}`. */
  pipSubs?: boolean;
}

export const DEFAULT_CAPS: Capabilities = {
  // Measured on the Series S by shell 0.1.30 (docs/bridge.md notes). No av1 decoder on the console.
  video: ['h264', 'hevc', 'mpeg2video', 'vc1', 'vp8', 'vp9'],
  audioNative: ['aac', 'ac3', 'alac', 'eac3', 'flac', 'mp3', 'opus'],
  audioFfmpeg: ['truehd', 'mlp', 'dts', 'dca'],
  containers: ['mkv', 'mp4', 'm4v', 'mov', 'ts'],
  maxAudioChannels: 8,
};

export interface PlayMsg {
  url: string;
  itemId: string;
  startMs: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  videoRangeType?: string;
  width?: number;
  height?: number;
  fps?: number;
  hdr: 'off' | 'auto';
  matchFrameRate: boolean;
  audioStreamIndex?: number;
  /** Audio boost / night mode for this playback (docs/bridge.md `setAudioBoost`). */
  audioBoost?: { db: number; night: boolean };
}

export type NativeMsg =
  | { type: 'capabilities' } & Partial<Capabilities>
  | { type: 'playbackState'; state: string; videoWidth?: number; videoHeight?: number; positionMs?: number }
  | { type: 'time'; positionMs: number; durationMs: number; bufferedMs?: number }
  | { type: 'tracks'; audio: { index: number; codec: string; channels: number; language: string; title: string }[]; selected?: number }
  | { type: 'decoder'; path: string; summary?: string }
  | { type: 'error'; code?: string; message: string; fatal?: boolean }
  | { type: 'playbackEnded' }
  | { type: 'back'; playing?: boolean }
  | { type: string; [k: string]: any };

type Listener = (m: NativeMsg) => void;
const listeners = new Set<Listener>();
const wv = (window as any).chrome?.webview as
  | { postMessage(m: unknown): void; addEventListener(t: string, cb: (e: { data: any }) => void): void }
  | undefined;

export const isNative = !!wv;
export let capabilities: Capabilities = { ...DEFAULT_CAPS };
let capsFromNative = false;
export const capsSource = () => (capsFromNative ? 'native' : 'defaults');

export function onNative(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(m: NativeMsg) {
  if (m.type === 'capabilities') {
    const c = m as any;
    capabilities = {
      ...DEFAULT_CAPS,
      ...Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== 'type' && v !== undefined && !(Array.isArray(v) && !v.length))),
    };
    capsFromNative = true;
    log('caps <- native', capabilities);
  }
  if (m.type !== 'time') log('native ->', m);
  for (const l of [...listeners]) {
    try {
      l(m);
    } catch (e) {
      log('listener error', e as Error);
    }
  }
}

export function send(msg: { type: string; [k: string]: unknown }) {
  if (msg.type !== 'seek' && msg.type !== 'setPipSubs' && !msg.step) log('-> native', msg.type === 'play' ? { ...msg, url: String(msg.url).replace(/api_key=[^&]+/i, 'api_key=<k>') } : msg);
  if (wv) wv.postMessage(msg);
  else mock.handle(msg);
}

if (wv) {
  wv.addEventListener('message', (e) => {
    let m = e.data;
    if (typeof m === 'string') {
      try {
        m = JSON.parse(m);
      } catch {
        return;
      }
    }
    if (m && typeof m.type === 'string') emit(m);
  });
}

// ---------------- mock bridge (desktop browser) ----------------
const mock = (() => {
  let video: HTMLVideoElement | null = null;
  // PiP (setVideoRect / setPipSubs): the subtitle line over the raised video, like the native TextBlock.
  let pipRect: { x: number; y: number; w: number; h: number } | null = null;
  let pipAnim: Animation | null = null;
  let pipSubsText = '';
  let pipSubsEl: HTMLDivElement | null = null;
  const pipSubsDraw = () => {
    const show = !!pipRect && !pipAnim && !!pipSubsText.trim();
    if (!show) {
      if (pipSubsEl) pipSubsEl.style.display = 'none';
      return;
    }
    if (!pipSubsEl) {
      pipSubsEl = document.createElement('div');
      pipSubsEl.id = 'mock-pip-subs';
      pipSubsEl.appendChild(document.createElement('span'));
      document.body.appendChild(pipSubsEl);
    }
    const r = pipRect!;
    const fs = Math.max(11, r.h * 0.075);
    Object.assign(pipSubsEl.style, { display: 'flex', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', paddingBottom: r.h * 0.05 + 'px', fontSize: fs + 'px' });
    pipSubsEl.firstElementChild!.textContent = pipSubsText;
  };
  let hls: Hls | null = null;
  let timer: number | undefined;
  const state = (s: string) => emit({ type: 'playbackState', state: s, videoWidth: video?.videoWidth, videoHeight: video?.videoHeight });
  const time = () =>
    video &&
    emit({
      type: 'time',
      positionMs: Math.round(video.currentTime * 1000),
      durationMs: Math.round((isFinite(video.duration) ? video.duration : 0) * 1000),
      bufferedMs: video.buffered.length ? Math.round(video.buffered.end(video.buffered.length - 1) * 1000) : undefined,
    });

  function ensure() {
    if (video) return video;
    video = document.getElementById('mock-video') as HTMLVideoElement;
    video.addEventListener('playing', () => state('Playing'));
    video.addEventListener('pause', () => !video!.ended && state('Paused'));
    video.addEventListener('waiting', () => state('Buffering'));
    video.addEventListener('seeked', time);
    video.addEventListener('ended', () => {
      state('Ended');
      emit({ type: 'playbackEnded' });
    });
    video.addEventListener('error', () => emit({ type: 'error', code: 'mock', message: video?.error?.message || 'media error', fatal: true }));
    video.addEventListener('loadedmetadata', () => {
      const anyV = video as any;
      const tracks = anyV.audioTracks
        ? Array.from(anyV.audioTracks as ArrayLike<any>).map((t: any, i: number) => ({ index: i, codec: '', channels: 2, language: t.language, title: t.label }))
        : [{ index: 0, codec: 'aac', channels: 2, language: '', title: 'Default' }];
      emit({ type: 'tracks', audio: tracks, selected: 0 });
    });
    return video;
  }

  function boost(v: HTMLVideoElement | null, b: { db?: number; night?: boolean }) {
    const want = { db: Number(b.db) || 0, night: !!b.night };
    const r = setWebBoost(v, want);
    emit({ type: 'audioBoost', ...want, path: 'webaudio', ...r });
  }

  function stop() {
    window.clearInterval(timer);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.classList.remove('on');
    }
  }

  return {
    handle(msg: any) {
      switch (msg.type) {
        case 'hello':
          setTimeout(() => emit({ type: 'capabilities', ...DEFAULT_CAPS, deviceForm: 'Desktop (mock)', hdrDisplay: false, pip: true, pipSubs: true }), 50);
          break;
        case 'play': {
          stop();
          const v = ensure();
          v.classList.add('on');
          state('Opening');
          const start = (msg.startMs || 0) / 1000;
          const url: string = msg.url;
          // Safari (iOS/iPadOS/macOS) plays HLS natively: more reliable than hls.js over ManagedMediaSource, and required
          // for iOS fullscreen (webkitEnterFullscreen). Chrome/Android/Firefox go through hls.js.
          const nativeHls = !!v.canPlayType('application/vnd.apple.mpegurl') && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android|Edg/.test(navigator.userAgent);
          if (url.includes('.m3u8') && !nativeHls && Hls.isSupported()) {
            hls = new Hls({ startPosition: start });
            hls.loadSource(url);
            hls.attachMedia(v);
          } else {
            v.src = url;
            v.addEventListener('loadedmetadata', () => (v.currentTime = start), { once: true });
          }
          v.play().catch((e) => emit({ type: 'error', code: 'mockPlay', message: String(e), fatal: false }));
          emit({ type: 'decoder', path: 'html5', summary: url.includes('.m3u8') ? (hls ? 'hls.js' : 'native HLS') : 'native <video>' });
          if (msg.audioBoost) boost(v, msg.audioBoost);
          timer = window.setInterval(time, 250);
          break;
        }
        case 'pause':
          video?.pause();
          break;
        case 'resume':
          video?.play();
          break;
        case 'seek':
          if (video) video.currentTime = msg.positionMs / 1000;
          break;
        case 'stop': {
          const pos = video ? Math.round(video.currentTime * 1000) : 0;
          stop();
          emit({ type: 'playbackState', state: 'Stopped', positionMs: pos } as NativeMsg);
          break;
        }
        case 'setVolume':
          if (video) video.volume = msg.value;
          break;
        case 'setVideoRect': {
          // Same contract as native (docs/bridge.md "Picture in picture"): rect in page CSS px, raised above the UI,
          // never hit-testable (clicks fall through to the PiP window under it); null = full screen behind the UI.
          // anim: FLIP from where the video is drawn now to the new box (transform only, on the compositor).
          const v = (video ?? document.getElementById('mock-video')) as HTMLVideoElement | null;
          const r = msg.rect as { x: number; y: number; w: number; h: number } | null;
          pipRect = r;
          if (v) {
            pipAnim?.cancel();
            pipAnim = null;
            const from = v.getBoundingClientRect();
            const st = v.style;
            if (r) {
              Object.assign(st, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto', zIndex: '2', pointerEvents: 'none', borderRadius: (msg.radius || 0) + 'px' });
            } else {
              for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom', 'zIndex', 'pointerEvents', 'borderRadius'] as const) st[k] = '';
            }
            const to = v.getBoundingClientRect();
            if (msg.anim && from.width > 0 && to.width > 0 && !document.documentElement.classList.contains('reduce-motion')) {
              const a = v.animate(
                [
                  { transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
                  { transformOrigin: '0 0', transform: 'none' },
                ],
                { duration: 360, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
              );
              pipAnim = a;
              // Leaving: stay above the UI while it grows, then drop behind.
              if (!r) st.zIndex = '2';
              a.onfinish = a.oncancel = () => {
                if (pipAnim !== a) return;
                pipAnim = null;
                if (!pipRect) st.zIndex = '';
                pipSubsDraw();
              };
            }
          }
          pipSubsDraw();
          setTimeout(() => emit({ type: 'videoRect', rect: r ?? null }), 0);
          break;
        }
        case 'setPipSubs':
          pipSubsText = String(msg.text ?? '');
          pipSubsDraw();
          break;
        case 'setAudioBoost':
          boost(video ?? (document.getElementById('mock-video') as HTMLVideoElement), msg);
          break;
        case 'setAudioTrack': {
          const at = (video as any)?.audioTracks;
          if (at) for (let i = 0; i < at.length; i++) at[i].enabled = i === msg.index;
          break;
        }
        case 'exit':
          log('mock: exit requested');
          break;
      }
    },
  };
})();

send({ type: 'hello' });
