// Picture-in-picture window (lib/pip.ts has the rules). The Player renders this instead of its overlay while `pip` is on.
// Layout: a 16:9 video box + a caption strip under it (title, progress, close). The real video sits exactly on the box:
// on Xbox the native MediaPlayerElement is raised above the WebView to the box's rect, in browsers #mock-video is moved
// there (lib/bridge.ts mock). Anything drawn INSIDE the box is covered by the video, so the controls live in the strip.
// Not focusable: the D-pad keeps moving through the app; Menu (global intercept) or a click/tap = full screen.
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { playback, pip, pipSubsSupported, sendPipSubs, sendVideoRect } from '../lib/pip';
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

  // Send the box's LAYOUT rect (offsets ignore CSS transforms, so the video heads for the final spot).
  // First send animates (the video, raised full size by Player's goPip, shrinks onto the box); later ones (resize,
  // dialog covered/uncovered) jump. Unmount back to full screen of the SAME session grows it back; closing doesn't.
  const resend = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    let anim = true;
    const key0 = playback.peek()?.key;
    const send = () => {
      const w = win.current;
      const b = box.current;
      if (!w || !b) return;
      if (coveredRef.current) return sendVideoRect(null);
      const r = { left: w.offsetLeft + w.clientLeft + b.offsetLeft, top: w.offsetTop + w.clientTop + b.offsetTop, width: b.offsetWidth, height: b.offsetHeight };
      const radius = parseFloat(getComputedStyle(b).borderTopLeftRadius) || 0;
      sendVideoRect({ getBoundingClientRect: () => r } as unknown as HTMLElement, radius, anim);
      anim = false;
    };
    send();
    resend.current = send;
    let raf = 0;
    const kick = () => void (raf ||= requestAnimationFrame(() => ((raf = 0), send())));
    addEventListener('resize', kick, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(kick) : null;
    if (ro && win.current) ro.observe(win.current);
    return () => {
      removeEventListener('resize', kick);
      ro?.disconnect();
      cancelAnimationFrame(raf);
      sendPipSubs('');
      const s = playback.peek();
      sendVideoRect(null, 0, !pip.peek() && !!s && s.key === key0);
    };
  }, []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    resend.current(); // null while covered, the box again after
  }, [covered]);

  // Subtitles: the video covers this part of the page, so the shell draws the line over it (lib/pip.ts sendPipSubs).
  useEffect(() => sendPipSubs(p.subs), [p.subs]);

  useEffect(() => {
    document.documentElement.classList.add('pip');
    return () => document.documentElement.classList.remove('pip');
  }, []);

  const stripSubs = !!p.subs && !pipSubsSupported();
  return (
    <div class="pip-win" ref={win} onClick={p.onFull} title="Full screen" role="button" aria-label={'Picture in picture: ' + p.title}>
      <div class={'pip-box' + (covered ? ' covered' : '')} ref={box}>
        {p.loading && <div class="spinner" />}
      </div>
      <div class="pip-cap">
        {/* Shells that can't draw subtitles over the video: the current line covers the title, under the picture.
            Title stays laid out (hidden) so the window never changes size (that would move the video). */}
        <div class="pip-text" style={stripSubs ? { visibility: 'hidden' } : undefined}>
          <div class="pip-title">{p.title}</div>
          <div class="pip-sub">{p.subtitle || '\u00a0'}</div>
        </div>
        {stripSubs && <div class="pip-subs-line">{p.subs}</div>}
        <div class="pip-hint" aria-hidden="true" style={stripSubs ? { visibility: 'hidden' } : undefined}>
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
        <div class="pip-prog">
          <i style={{ transform: `scaleX(${p.pct})` }} />
        </div>
      </div>
    </div>
  );
}
