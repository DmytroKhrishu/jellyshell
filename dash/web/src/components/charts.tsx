// Tiny SVG charts, no chart library. Sparks scale with their container; HourlyChart draws 1:1 in pixels.
import qrcode from 'qrcode-generator';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

function path(values: (number | null)[], w: number, h: number, min: number, max: number) {
  const span = max - min || 1;
  const n = values.length;
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    const x = n > 1 ? (i / (n - 1)) * w : 0;
    const y = h - ((v - min) / span) * h;
    d += (d ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2);
  });
  return d;
}

export function Spark({ values, color = 'var(--accent)', min, max, height = '4rem', fill = true }: {
  values: (number | null)[];
  color?: string;
  min?: number;
  max?: number;
  height?: string;
  fill?: boolean;
}) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <div class="spark" style={{ height }} />;
  const lo = min ?? Math.min(...nums);
  const hi = max ?? Math.max(...nums);
  const W = 100;
  const H = 40;
  const d = path(values, W, H, lo, hi);
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={color} stop-opacity="0.45" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${d}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

/**
 * Hourly temperature line + precipitation-probability bars with hour labels.
 * Measures its own pixel box and draws at a 1:1 viewBox, so strokes and text are never stretched.
 */
export function HourlyChart({ temps, precip, labels, height = '12rem' }: {
  temps: number[];
  precip: number[];
  labels: string[];
  height?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; rem: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // clientWidth ignores the focus scale() transform -> stable 1:1 size
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const w = el.clientWidth;
      const h = el.clientHeight;
      setBox((b) => (b && b.w === w && b.h === h && b.rem === rem ? b : { w, h, rem }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let svg: any = null;
  if (box && box.w > 0 && box.h > 0 && temps.length > 1) {
    const { w: W, h: H, rem } = box;
    const padX = 1.4 * rem;
    const top = 2.2 * rem; // room for the value labels above the line
    const labelH = 2.2 * rem; // hour labels row
    const plotB = H - labelH;
    const n = temps.length;
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const span = Math.max(1, hi - lo);
    const step = (W - 2 * padX) / (n - 1);
    const x = (i: number) => padX + i * step;
    // line uses the upper ~70% of the plot, precip bars the lower part
    const y = (t: number) => top + (1 - (t - lo) / span) * (plotB - top) * 0.7;
    const d = temps.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t).toFixed(1)}`).join('');
    const barMax = (plotB - top) * 0.45;
    const barW = Math.max(4, step * 0.55);
    svg = (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="hourly-svg">
        <defs>
          <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#fbbf24" stop-opacity="0" />
          </linearGradient>
        </defs>
        <line x1={padX} x2={W - padX} y1={plotB + 0.5} y2={plotB + 0.5} stroke="rgba(255,255,255,.12)" stroke-width="1" />
        {precip.map((p, i) =>
          p > 0 ? (
            <rect x={x(i) - barW / 2} y={plotB - (p / 100) * barMax} width={barW} height={(p / 100) * barMax} rx={Math.min(4, barW / 3)} fill="#60a5fa" opacity="0.6" />
          ) : null,
        )}
        <path d={`${d}L${x(n - 1)},${plotB}L${x(0)},${plotB}Z`} fill="url(#hg)" />
        <path d={d} fill="none" stroke="#fbbf24" stroke-width={0.22 * rem} stroke-linejoin="round" stroke-linecap="round" />
        {temps.map((t, i) =>
          i % 3 === 0 ? (
            <g>
              <circle cx={x(i)} cy={y(t)} r={0.3 * rem} fill="#fbbf24" />
              <text x={x(i)} y={y(t) - 0.75 * rem} text-anchor="middle" class="hc-t" style={{ fontSize: `${1.45 * rem}px` }}>{Math.round(t)}°</text>
              <text x={x(i)} y={H - 0.45 * rem} text-anchor="middle" class="hc-l" style={{ fontSize: `${1.2 * rem}px` }}>{labels[i]}</text>
              {precip[i] >= 20 && (
                <text x={x(i)} y={plotB - (precip[i] / 100) * barMax - 0.35 * rem} text-anchor="middle" class="hc-p" style={{ fontSize: `${0.95 * rem}px` }}>{precip[i]}%</text>
              )}
            </g>
          ) : null,
        )}
      </svg>
    );
  }
  return <div ref={ref} class="hourly" style={{ height }}>{svg}</div>;
}

export function Ring({ pct, color = 'var(--accent)', size = '6rem', children }: { pct: number; color?: string; size?: string; children?: any }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div class="ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,.12)" stroke-width="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} stroke-width="9" stroke-linecap="round"
          stroke-dasharray={`${(c * Math.min(100, Math.max(0, pct))) / 100} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <div class="ring-c">{children}</div>
    </div>
  );
}

export function QR({ text, size = '9rem' }: { text: string; size?: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const svg = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return <div class="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
