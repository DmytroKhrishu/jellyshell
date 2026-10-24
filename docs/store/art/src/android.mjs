// Android TV art: leanback banner 320x180 (mark + title) + launcher icons (mipmap densities).
// Run from ~/.hermes/cache/scratch/icons: node <repo>/docs/store/art/src/android.mjs <repo>/android/app/src/main/res
import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import { svg } from './marks.mjs';
const res = process.argv[2];
const mark = (cx, cy, s) => `<g transform="translate(${cx} ${cy}) scale(${s})"><path d="M63.84,-4.46 A64,64 0 1 1 -6.69,-63.65" fill="none" stroke="#f5f5f7" stroke-width="34" stroke-linecap="round"/><circle cx="41.14" cy="-49.03" r="18" fill="#a78bfa"/></g>`;
const bg = (w, h) => `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1a24"/><stop offset="1" stop-color="#07070b"/></linearGradient>
<radialGradient id="glow" cx="0.3" cy="0.4" r="0.7"><stop offset="0" stop-color="#a78bfa" stop-opacity="0.14"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/><rect width="${w}" height="${h}" fill="url(#glow)"/>`;
const title = `<text x="118" y="104" fill="#f5f5f7" font-family="Inter, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="600" letter-spacing="-0.8">JellyShell</text>`;
const put = (path, s) => {
  fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(path, new Resvg(s, { font: { loadSystemFonts: true } }).render().asPng());
  console.log(path);
};
// Banner 320x180 (xhdpi; Android TV scales it). Mark at left, title right of it.
put(`${res}/drawable-xhdpi/banner.png`, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">${bg(320, 180)}${mark(70, 92, 0.44)}${title}</svg>`);
// Launcher icon: plated square mark.
for (const [d, n] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  put(`${res}/mipmap-${d}/ic_launcher.png`, svg('pearl', n, n, { markFrac: 0.58, rounded: n * 0.18 }));
}
