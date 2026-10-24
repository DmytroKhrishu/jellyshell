import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import { svg, PAL } from './marks.mjs';
const A = process.argv[2];
const M = 'pearl';
const sizeOf = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const small = (n) => n <= 32;
const out = [];
for (const f of fs.readdirSync(A).filter((f) => f.endsWith('.png')).sort()) {
  const [w, h] = sizeOf(`${A}/${f}`);
  let o;
  if (f.startsWith('Square44x44Logo')) {
    const n = Math.min(w, h);
    if (f.includes('lightunplated')) o = { plate: false, col: PAL.ink, acc: '#6d28d9', markFrac: small(n) ? 0.9 : 0.84 };
    else if (f.includes('unplated')) o = { plate: false, markFrac: small(n) ? 0.9 : 0.84 };
    else o = { markFrac: small(n) ? 0.74 : 0.62 };
  } else if (f.startsWith('SplashScreen')) o = { plate: false, markFrac: 0.42 };
  else if (f.startsWith('Wide310x150')) o = { markFrac: 0.44 };
  else if (f.startsWith('LargeTile')) o = { markFrac: 0.46 };
  else if (f.startsWith('SmallTile')) o = { markFrac: 0.56 };
  else if (f.startsWith('StoreLogo')) o = { markFrac: 0.58 };
  else o = { markFrac: 0.46 }; // Square150x150
  fs.writeFileSync(`${A}/${f}`, new Resvg(svg(M, w, h, o)).render().asPng());
  const [w2, h2] = sizeOf(`${A}/${f}`);
  out.push(`${f} ${w2}x${h2}${w2 !== w || h2 !== h ? ' MISMATCH' : ''}`);
}
console.log(out.join('\n'));
