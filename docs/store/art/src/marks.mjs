// Minimal JellyShell marks. Each mark draws in a 200x200 unit box centred at 0,0.
// col = mark colour, bgc = background colour (for negative-space cutouts).
export const PAL = {
  bgTop: '#1b1a24',   // subtle lift, matches --glass tone
  bgBot: '#07070b',   // --bg
  fg: '#f5f5f7',      // --fg
  accent: '#a78bfa',  // --accent
  ink: '#0b0b10',     // --focus-fill-fg (for light-theme unplated)
};

// A: Shell — one thick open ring (~290°) with round caps; the gap faces upper right.
const shell = (col) => {
  const r = 70, sw = 34;
  const a0 = -20 * Math.PI / 180, a1 = 250 * Math.PI / 180; // gap from -90..-20 (upper right)
  const p = (a) => `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  return `<path d="M${p(a0)} A${r},${r} 0 1 1 ${p(a1)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
};

// B: Soft play — a single rounded triangle, optically centred.
const play = (col) =>
  `<path d="M-38,-62 L70,0 L-38,62 Z" transform="translate(-8 0)" fill="${col}" stroke="${col}" stroke-width="34" stroke-linejoin="round"/>`;

// C: Abstract J — one stroke: stem down, curling left; round caps.
const jay = (col) =>
  `<path d="M28,-78 L28,22 A52,52 0 0 1 -76,22" transform="translate(16 0)" fill="none" stroke="${col}" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>`;

// D: Pane — a soft rounded screen with a play notch cut out (negative space).
const pane = (col) =>
  `<mask id="pm" maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200"><rect x="-100" y="-100" width="200" height="200" fill="#fff"/>
   <path d="M-14,-26 L26,0 L-14,26 Z" fill="#000" stroke="#000" stroke-width="16" stroke-linejoin="round"/></mask>
   <rect x="-86" y="-62" width="172" height="124" rx="34" fill="${col}" mask="url(#pm)"/>`;

// A': Shell + pearl — open ring (wider gap) holding one accent dot in the gap.
const pearl = (col, _bgc, acc = PAL.accent) => {
  const r = 64, sw = 34;
  const g0 = -96, g1 = -4; // gap in degrees (upper right); ~15u clearance each side of the pearl
  const rad = (d) => d * Math.PI / 180;
  const p = (d) => `${(r * Math.cos(rad(d))).toFixed(2)},${(r * Math.sin(rad(d))).toFixed(2)}`;
  const mid = rad((g0 + g1) / 2);
  return `<path d="M${p(g1)} A${r},${r} 0 1 1 ${p(g0)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>
  <circle cx="${(r * Math.cos(mid)).toFixed(2)}" cy="${(r * Math.sin(mid)).toFixed(2)}" r="18" fill="${acc}"/>`;
};

// E: Arch — a thick rounded arch (the "shell") sheltering a small soft play mark.
const arch = (col) =>
  `<path d="M-70,64 L-70,-4 A70,70 0 0 1 70,-4 L70,64" fill="none" stroke="${col}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
   <path d="M-12,8 L22,28 L-12,48 Z" transform="translate(-3 0)" fill="${col}" stroke="${col}" stroke-width="18" stroke-linejoin="round"/>`;

// B2: Soft play with a faint top-to-bottom tonal fill (white -> lavender).
const play2 = (col) =>
  `<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}"/><stop offset="1" stop-color="#d9ccff"/></linearGradient></defs>
   <path d="M-38,-62 L70,0 L-38,62 Z" transform="translate(-8 0)" fill="url(#pg)" stroke="url(#pg)" stroke-width="34" stroke-linejoin="round"/>`;

export const MARKS = { shell, pearl, arch, play, play2, jay, pane };

const defs = `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAL.bgTop}"/><stop offset="1" stop-color="${PAL.bgBot}"/></linearGradient>
</defs>`;

// Full asset. markFrac = mark box (200u) as a fraction of min(w,h). cx/cy = centre as fraction.
export function svg(markName, w, h, { markFrac = 0.5, plate = true, col = PAL.fg, acc = PAL.accent, cx = 0.5, cy = 0.5, rounded = 0 } = {}) {
  const s = (Math.min(w, h) * markFrac) / 200;
  const bgc = plate ? PAL.bgBot : 'transparent';
  const bg = plate ? `<rect width="${w}" height="${h}" rx="${rounded}" fill="url(#bg)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${bg}
<g transform="translate(${w * cx} ${h * cy}) scale(${s})">${MARKS[markName](col, null, acc)}</g></svg>`;
}
