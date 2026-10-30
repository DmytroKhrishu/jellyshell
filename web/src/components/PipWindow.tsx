// Picture-in-picture window (lib/pip.ts has the rules). The Player renders this instead of its overlay while `pip` is on.
// Layout: a 16:9 video box, the progress line right under it, then a caption strip (title, close). The real video sits exactly on the box:
// on Xbox the native MediaPlayerElement is raised above the WebView to the box's rect, in browsers #mock-video is moved
// there (lib/bridge.ts mock). Anything drawn INSIDE the box is covered by the video, so the controls live in the strip.
// Not focusable: the D-pad keeps moving through the app; Menu (global intercept) or a click/tap = full screen.
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { playback, pip, pipLeaving, pipSubsSupported, sendPipSubs, sendVideoRect, videoBehind } from '../lib/pip';
import { dialog } from './Dialog';
import { Icon } from './icons';
import '../styles/pip.css';

export function PipWindow(p: { title: string; subtitle: string; subs: string; pct: number; loading: boolean; paused: boolean; onFull: () => void; onClose: () => void }) {
  const win = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // The raised video covers everything under its rect (native: it sits above the whole WebView). While a dialog or
  // the context menu is up, park the video behind the (opaque) UI instead: sound keeps playing, the dialog stays readable.
  const covered = !!dialog.value;
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const leaving = pipLeaving.value;
  const animated = pipSubsSupported(); // the shell animates the move (else it jumps: no delayed fade-in either)

  // Send the box's LAYOUT rect (offsets ignore CSS transforms). The video arrives raised at full size (Player goPip ->
  // raiseVideoFull); the first rect is sent once the browsing page under it has painted and moves it into the box
  // (animated where the shell can). Later sends (resize, dialog covered/uncovered) jump; repeats are dropped in lib/pip.ts.
  const resend = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const key0 = playback.peek()?.key;
    let started = false;
    const send = (anim = false) => {
      const w = win.current;
      const b = box.current;
      if (!w || !b || pipLeaving.peek()) return;
      if (coveredRef.current) return sendVideoRect(null);
      const r = { left: w.offsetLeft + w.clientLeft + b.offsetLeft, top: w.offsetTop + w.clientTop + b.offsetTop, width: b.offsetWidth, height: b.offsetHeight };
      const radius = parseFloat(getComputedStyle(b).borderTopLeftRadius) || 0;
      sendVideoRect({ getBoundingClientRect: () => r } as unknown as HTMLElement, radius, anim);
    };
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        raf = 0;
        started = true;
        send(true);
      });
    });
    resend.current = () => started && send();
    const kick = () => void (started && (raf ||= requestAnimationFrame(() => ((raf = 0), send()))));
    addEventListener('resize', kick, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(kick) : null;
    if (ro && win.current) ro.observe(win.current);
    return () => {
      removeEventListener('resize', kick);
      ro?.disconnect();
      cancelAnimationFrame(raf);
      sendPipSubs('');
      // Next episode in PiP (lib/router.ts replacePlayer): a new Player's PipWindow takes over the same box; leave it.
      if (pip.peek() && playback.peek()) return;
      const s = playback.peek();
      videoBehind(!!s && s.key === key0);
    };
  }, []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    resend.current(); // null while covered, the box again after
  }, [covered]);

  // Subtitles: the video covers this part of the page, so the shell draws the line over it (lib/pip.ts sendPipSubs).
  useEffect(() => sendPipSubs(p.subs), [p.subs]);

  useLayoutEffect(() => {
    document.documentElement.classList.add('pip');
    return () => document.documentElement.classList.remove('pip');
  }, []);

  return (
    <div
      class={'pip-win' + (animated ? ' pip-anim' : '') + (leaving ? ' leaving' : '')}
      ref={win}
      onClick={p.onFull}
      title="Full screen"
      role="button"
      aria-label={'Picture in picture: ' + p.title}
    >
      <div class={'pip-box' + (covered ? ' covered' : '')} ref={box}>
        {p.loading && <div class="spinner" />}
      </div>
      <div class="pip-prog">
        <i style={{ transform: `scaleX(${p.pct})` }} />
      </div>
      <div class="pip-cap">
        <div class="pip-text">
          <div class="pip-title">{p.title}</div>
          {p.subtitle && <div class="pip-sub">{p.subtitle}</div>}
        </div>
        <div class="pip-hint" aria-hidden="true">
          <Icon name="menuBtn" />
          Full screen
        </div>
        <button
          class="pip-close"
          aria-label="Stop playback"
          title="Stop playback"
          onClick={(e) => {
            e.stopPropagation();
            p.onClose();
          }}
        >
          <Icon name="close" stroke={2.4} />
        </button>
      </div>
    </div>
  );
}
