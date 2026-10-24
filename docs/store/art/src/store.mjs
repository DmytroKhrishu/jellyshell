import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import { svg, MARKS, PAL } from './marks.mjs';
const D = process.argv[2];
fs.mkdirSync(D, { recursive: true });
// Large art: same plate + a very faint violet halo behind the mark so big canvases aren't dead flat.
const art = (w, h, { markFrac, cx = 0.5, cy = 0.5 }) => {
  const base = svg('pearl', w, h, { markFrac, cx, cy });
  const R = Math.min(w, h) * markFrac * 1.1;
  const halo = `<radialGradient id="halo" gradientUnits="userSpaceOnUse" cx="${w * cx}" cy="${h * cy}" r="${R}"><stop offset="0" stop-color="${PAL.accent}" stop-opacity="0.10"/><stop offset="1" stop-color="${PAL.accent}" stop-opacity="0"/></radialGradient>`;
  return base.replace('</defs>', `${halo}</defs>`).replace('<g transform', `<rect width="${w}" height="${h}" fill="url(#halo)"/><g transform`);
};
const jobs = [
  ['app-tile-icon-300x300.png', 300, 300, { markFrac: 0.5 }],
  ['box-art-1x1-1080x1080.png', 1080, 1080, { markFrac: 0.4, cy: 0.44 }],
  ['box-art-1x1-2160x2160.png', 2160, 2160, { markFrac: 0.4, cy: 0.44 }],
  ['poster-art-2x3-720x1080.png', 720, 1080, { markFrac: 0.46, cy: 0.42 }],
  ['poster-art-2x3-1440x2160.png', 1440, 2160, { markFrac: 0.46, cy: 0.42 }],
  ['super-hero-art-16x9-1920x1080.png', 1920, 1080, { markFrac: 0.36, cx: 0.68, cy: 0.5 }],
  ['super-hero-art-16x9-3840x2160.png', 3840, 2160, { markFrac: 0.36, cx: 0.68, cy: 0.5 }],
];
for (const [f, w, h, o] of jobs) {
  const s = f.startsWith('app-tile') ? svg('pearl', w, h, o) : art(w, h, o);
  fs.writeFileSync(`${D}/${f}`, new Resvg(s).render().asPng());
  console.log(f);
}
fs.writeFileSync(`${D}/mark.svg`, svg('pearl', 1024, 1024, { markFrac: 0.5 }));
fs.writeFileSync(`${D}/mark-unplated.svg`, svg('pearl', 1024, 1024, { markFrac: 0.9, plate: false }));
