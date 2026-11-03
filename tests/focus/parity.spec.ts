// Static guard for the two copies of the focus engine (web/src/lib/focus.ts, dash/web/src/lib/focus.ts).
// Every function that exists in both must have the same body (comments and whitespace ignored), except the few that
// differ on purpose (listed below with the reason). A fix applied to only one copy fails here with the function's name.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COPIES, ROOT } from './harness';

/** Functions whose bodies differ on purpose. Their behaviour is covered by engine.spec.ts on both copies. */
const DIVERGENT: Record<string, string> = {
  move: 'media: quiet flag + rowEntry; dash: far (other-column) rule',
  reveal: 'media: native scrolling in mode-mobile',
  wheelScroll: 'media: native scrolling in mode-mobile',
  resetScroll: 'media: native scrolling in mode-mobile',
};
/** Functions that exist in one copy only. */
const ONE_SIDED: Record<string, string> = {
  rowEntry: 'media only (see ONLY in harness.ts)',
};

function functions(file: string) {
  const src = readFileSync(resolve(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out = new Map<string, string>();
  const re = /^(?:export\s+)?function\s+(\w+)\s*\(/gm;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    // Body = from the first '{' after the parameter list to its matching '}'.
    let i = src.indexOf('{', src.indexOf(')', m.index));
    const start = i;
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.set(m[1], src.slice(m.index, start).replace(/\s+/g, ' ').trim() + src.slice(start, i + 1).replace(/\s+/g, ' '));
  }
  return out;
}

test('both focus.ts copies define the same functions with the same bodies', () => {
  const [media, dash] = COPIES.map((c) => functions(c.file));
  expect(media.size, 'parser found the media functions').toBeGreaterThan(15);
  const names = new Set([...media.keys(), ...dash.keys()]);
  const problems: string[] = [];
  for (const n of names) {
    if (ONE_SIDED[n]) continue;
    if (!media.has(n) || !dash.has(n)) {
      problems.push(`${n}() exists only in ${media.has(n) ? COPIES[0].file : COPIES[1].file}: port it, or list it in ONE_SIDED with a reason`);
      continue;
    }
    if (!DIVERGENT[n] && media.get(n) !== dash.get(n)) problems.push(`${n}() differs between the copies: port the fix to both, or list it in DIVERGENT with a reason`);
  }
  for (const n of Object.keys(ONE_SIDED)) if (media.has(n) && dash.has(n)) problems.push(`${n}() is in both copies now: drop it from ONE_SIDED`);
  expect(problems).toEqual([]);
});
