import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import { svg, MARKS, PAL } from './marks.mjs';

fs.mkdirSync('out', { recursive: true });
const png = (s, w) => new Resvg(s, w ? { fitTo: { mode: 'width', value: w } } : {}).render().asPng();
for (const m of Object.keys(MARKS)) {
  fs.writeFileSync(`out/c-${m}-300.png`, png(svg(m, 300, 300, { markFrac: 0.46 })));
  fs.writeFileSync(`out/c-${m}-44.png`, png(svg(m, 44, 44, { markFrac: 0.62 })));
  fs.writeFileSync(`out/c-${m}-24.png`, png(svg(m, 24, 24, { markFrac: 0.7 })));
}

// Comparison sheet: per concept a 300 tile, a 620x300 wide tile, then 44 and 24 at 1:1 and 4x nearest-neighbour.
const CHOSEN = process.argv[2] || '';
const W = 1900, rowH = 380;
const names = Object.keys(MARKS);
const label = { shell: 'A  Shell (open ring)', pearl: 'A2  Shell + pearl (ring holding one accent dot)', arch: 'E  Arch (shell over a play mark)', play: 'B  Soft play', play2: 'B2  Soft play, tonal', jay: 'C  Abstract J', pane: 'D  Pane (play cut-out)' };
let body = '';
names.forEach((m, i) => {
  const y = 40 + i * rowH;
  const emb = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const wide = 'data:image/png;base64,' + Buffer.from(png(svg(m, 620, 300, { markFrac: 0.46 }))).toString('base64');
  body += `<text x="40" y="${y + 20}" fill="${PAL.fg}" font-family="sans-serif" font-size="26" font-weight="600">${label[m]}${m === CHOSEN ? '   (chosen)' : ''}</text>
<image x="40" y="${y + 40}" width="300" height="300" href="${emb(`out/c-${m}-300.png`)}"/>
<image x="370" y="${y + 40}" width="620" height="300" href="${wide}"/>
<image x="1030" y="${y + 40}" width="44" height="44" href="${emb(`out/c-${m}-44.png`)}"/>
<image x="1100" y="${y + 40}" width="24" height="24" href="${emb(`out/c-${m}-24.png`)}"/>
<image x="1150" y="${y + 40}" width="176" height="176" href="${emb(`out/c-${m}-44.png`)}" style="image-rendering:pixelated"/>
<image x="1360" y="${y + 40}" width="96" height="96" href="${emb(`out/c-${m}-24.png`)}" style="image-rendering:pixelated"/>
<text x="1150" y="${y + 250}" fill="#888" font-family="sans-serif" font-size="18">44px and 24px, actual size and 4x zoom</text>`;
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${40 + names.length * rowH}"><rect width="100%" height="100%" fill="#2a2a30"/>${body}</svg>`;
fs.writeFileSync('out/concepts.png', new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng());
console.log('ok');
