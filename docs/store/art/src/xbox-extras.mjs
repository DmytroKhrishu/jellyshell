// Xbox listing extras: branded key art 584x800 + titled hero 1920x1080 (title in top 3/4), featured square 1080 (no title).
import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
const out = process.argv[2] || '.';
const bg = (w, h) => `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1a24"/><stop offset="1" stop-color="#07070b"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.35" r="0.6"><stop offset="0" stop-color="#a78bfa" stop-opacity="0.10"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/><rect width="${w}" height="${h}" fill="url(#glow)"/>`;
const mark = (cx, cy, s) => `<g transform="translate(${cx} ${cy}) scale(${s})"><path d="M63.84,-4.46 A64,64 0 1 1 -6.69,-63.65" fill="none" stroke="#f5f5f7" stroke-width="34" stroke-linecap="round"/><circle cx="41.14" cy="-49.03" r="18" fill="#a78bfa"/></g>`;
const title = (x, y, size, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="#f5f5f7" font-family="Inter, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif" font-size="${size}" font-weight="600" letter-spacing="${-size * 0.02}">JellyShell</text>`;
const svgs = {
  'xbox-branded-key-art-584x800.png': [584, 800, mark(292, 250, 1.05) + title(292, 470, 76)],
  'xbox-titled-hero-art-1920x1080.png': [1920, 1080, mark(960, 330, 1.35) + title(960, 610, 120)],
  'xbox-featured-square-1080x1080.png': [1080, 1080, mark(540, 540, 2.2)],
};
for (const [name, [w, h, body]] of Object.entries(svgs)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg(w, h)}${body}</svg>`;
  fs.writeFileSync(`${out}/${name}`, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
  console.log(`${out}/${name}`);
}
