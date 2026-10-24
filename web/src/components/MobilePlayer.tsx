// Mobile player layer (html.mode-mobile only): tap = show/hide controls, double-tap left/right third = ∓10 s,
// a big centre play/pause with ±10 s buttons, a close button and fullscreen (+ landscape lock where allowed).
// The existing seek bar, Audio & Subtitles, Episodes etc. stay in the Player's own bottom bar.
import { useRef, useState } from 'preact/hooks';
import { isIOS } from '../lib/mode';

const DOUBLE_MS = 280;

function Svg({ d, size = 26, fill = false }: { d: string; size?: number; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d={d} />
    </svg>
  );
}
const PLAY = 'M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z';
const PAUSE = 'M7 5h3v14H7zM14 5h3v14h-3z';
const BACK10 = 'M12 5a7 7 0 1 1-6.6 4.7M5 4v5h5';
const FWD10 = 'M12 5a7 7 0 1 0 6.6 4.7M19 4v5h-5';
const CLOSE = 'M6 6l12 12M18 6 6 18';
const FS_ON = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
const FS_OFF = 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5';

const fsElement = () => document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;

/** Fullscreen the whole player (web-rendered subtitles stay visible) and lock to landscape where the browser allows it.
 *  iPhone Safari has no element fullscreen: fall back to the <video>'s own native fullscreen. */
export async function toggleFullscreen() {
  const doc = document as any;
  const root = document.documentElement as any;
  try {
    if (fsElement()) {
      try {
        (screen.orientation as any)?.unlock?.();
      } catch {
        /* not supported */
      }
      await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }
    if (root.requestFullscreen || root.webkitRequestFullscreen) {
      await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen());
      await (screen.orientation as any)?.lock?.('landscape').catch(() => undefined);
      return;
    }
  } catch {
    /* fall through to the video element */
  }
  const v = document.getElementById('mock-video') as any;
  if (isIOS && v?.webkitEnterFullscreen) v.webkitEnterFullscreen();
}

export function MobilePlayerLayer(p: { ui: boolean; paused: boolean; onToggleUi: () => void; onTogglePause: () => void; onSeekBy: (ms: number) => void; onClose: () => void; onActivity: () => void }) {
  const last = useRef({ t: 0, x: 0, timer: 0 as number | undefined, streak: 0, side: '' });
  const [ripple, setRipple] = useState<{ side: 'l' | 'r'; n: number; k: number } | null>(null);
  const [fs, setFs] = useState(!!fsElement());

  const onTap = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const w = el.clientWidth;
    const x = e.clientX;
    const side = x < w * 0.38 ? 'l' : x > w * 0.62 ? 'r' : '';
    const L = last.current;
    const now = performance.now();
    const prevT = L.t;
    const prevSide = L.side;
    L.t = now;
    L.side = side;
    // double-tap on the left/right = ∓10 s; further quick taps on the same side keep adding 10 s
    const quick = !!side && side === prevSide && now - prevT < (L.streak > 0 ? 700 : DOUBLE_MS);
    if (quick) {
      window.clearTimeout(L.timer);
      L.streak++;
      p.onSeekBy(side === 'l' ? -10000 : 10000);
      setRipple((r) => ({ side: side as 'l' | 'r', n: r && r.side === side ? r.n + 10 : 10, k: now }));
      L.timer = window.setTimeout(() => {
        L.streak = 0;
        setRipple(null);
      }, 700);
      return;
    }
    L.streak = 0;
    window.clearTimeout(L.timer);
    L.timer = window.setTimeout(() => p.onToggleUi(), side ? DOUBLE_MS : 0);
  };

  return (
    <>
      <div class="m-gest" onClick={(e) => (e.stopPropagation(), onTap(e))} />
      {ripple && (
        <div key={ripple.k} class={'m-ripple ' + ripple.side}>
          {ripple.side === 'l' ? '−' : '+'}
          {ripple.n} s
        </div>
      )}
      <div class={'m-ptop' + (p.ui ? ' on' : '')}>
        <button aria-label="Close player" onClick={(e) => (e.stopPropagation(), p.onClose())}>
          <Svg d={CLOSE} size={22} />
        </button>
        <button
          class="m-fs"
          aria-label={fs ? 'Exit full screen' : 'Full screen'}
          onClick={async (e) => {
            e.stopPropagation();
            p.onActivity();
            await toggleFullscreen();
            setFs(!!fsElement());
          }}
        >
          <Svg d={fs ? FS_OFF : FS_ON} size={22} />
        </button>
      </div>
      <div class={'m-center' + (p.ui ? ' on' : '')} onClick={(e) => e.stopPropagation()}>
        <button class="m-skip" aria-label="Back 10 seconds" onClick={() => (p.onActivity(), p.onSeekBy(-10000))}>
          <Svg d={BACK10} size={30} />
          <b>10</b>
        </button>
        <button class="m-pp" aria-label={p.paused ? 'Play' : 'Pause'} onClick={() => (p.onActivity(), p.onTogglePause())}>
          <Svg d={p.paused ? PLAY : PAUSE} size={38} fill />
        </button>
        <button class="m-skip" aria-label="Forward 10 seconds" onClick={() => (p.onActivity(), p.onSeekBy(10000))}>
          <Svg d={FWD10} size={30} />
          <b>10</b>
        </button>
      </div>
    </>
  );
}
