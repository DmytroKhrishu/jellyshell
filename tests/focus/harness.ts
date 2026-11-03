// Loads one copy of the focus engine into a blank page, so the same spec runs against both:
//   web/src/lib/focus.ts       (media app)
//   dash/web/src/lib/focus.ts  (Dash: a separate copy, fixes have to be ported by hand)
// Real Chromium layout (getBoundingClientRect, offsets, computed transforms), no app code, no network.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '../..');

export const COPIES = [
  { name: 'media', file: 'web/src/lib/focus.ts' },
  { name: 'dash', file: 'dash/web/src/lib/focus.ts' },
] as const;
export type Copy = (typeof COPIES)[number];

/**
 * Engine features that exist in ONE copy on purpose. Everything else must behave the same in both, so a test that is not
 * listed here runs against both copies and a fix made in only one of them fails. Add an entry only with a reason.
 */
export const ONLY: Record<string, { copy: Copy['name']; why: string }> = {
  rowEntry: { copy: 'media', why: 'dash rows are only entered from the tab bar, which restores the page (focusFirst), never via move()' },
  quiet: { copy: 'media', why: "move(dir, quiet) is the player's Up-hides-the-overlay; dash has no player" },
  nativeScroll: { copy: 'media', why: 'mobile layout (html.mode-mobile) scrolls natively; dash is TV-only' },
  far: { copy: 'dash', why: 'Up/Down into another column ranks below the tab bar (Overview columns); the media pages need the column jump' },
};

const bundles = new Map<string, Promise<string>>();
function bundle(file: string) {
  let b = bundles.get(file);
  if (!b) {
    b = build({ entryPoints: [resolve(ROOT, file)], bundle: true, format: 'iife', globalName: 'F', write: false, target: 'chrome100', logLevel: 'silent' }).then(
      (r) => r.outputFiles[0].text,
    );
    bundles.set(file, b);
  }
  return b;
}

/** App-like geometry: 1rem = 16px, safe-x 80px, row rules copied from web/src/styles/app.css (same in dash). Transitions off. */
export const BASE_CSS = `
  :root { --safe-x: 80px; --card-gap: 24px; }
  html, body { margin: 0; }
  body { width: 1920px; height: 1080px; overflow: hidden; font: 16px/1.2 sans-serif; position: relative; }
  * { transition: none !important; box-sizing: content-box; }
  .focusable { outline: none; }
  .page-pad { padding: 120px var(--safe-x) 0; }
  .row { margin-top: 40px; }
  .row-viewport { margin: 0 calc(-1 * var(--safe-x)); padding: 0 var(--safe-x); }
  .row-track { display: flex; gap: var(--card-gap); padding: 14px var(--safe-x) 18px; margin: -14px calc(-1 * var(--safe-x)) -18px; }
  .card { flex: none; width: 300px; height: 170px; transform-origin: 50% 50%; background: #333; }
  .card:focus { transform: scale(1.08); }
  .btn-row, .pills { display: flex; gap: 16px; }
  .btn { width: 200px; height: 60px; background: #444; }
  .pill { width: 160px; height: 50px; background: #555; }
  .tabbar { position: absolute; top: 20px; left: 0; right: 0; display: flex; justify-content: center; gap: 12px; }
  .tab { width: 140px; height: 44px; background: #222; }
`;

export async function load(page: Page, copy: Copy, html: string, css = '') {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setContent(`<!doctype html><html><head><style>${BASE_CSS}${css}</style></head><body>${html}</body></html>`);
  await page.addScriptTag({ content: await bundle(copy.file) });
}

/** Spatial move like a D-pad press; returns whether focus moved. */
export const press = (page: Page, dir: 'up' | 'down' | 'left' | 'right', quiet?: boolean) =>
  page.evaluate(([d, q]) => (window as any).F.move(d, q), [dir, quiet] as const);

/** Focus by data-fkey through the engine (records group memory + reveals, like the app). */
export const focus = (page: Page, key: string) =>
  page.evaluate((k) => (window as any).F.focusEl(document.querySelector(`[data-fkey="${k}"]`), { instant: true }), key);

export const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.fkey ?? null);

export const rect = (page: Page, key: string) =>
  page.evaluate((k) => {
    const r = document.querySelector(`[data-fkey="${k}"]`)!.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, key);

export const cards = (prefix: string, n: number, attrs: (i: number) => string = () => '') =>
  Array.from({ length: n }, (_, i) => `<div class="card focusable" data-fkey="${prefix}${i + 1}" ${attrs(i + 1)}></div>`).join('');

export const row = (group: string, prefix: string, n: number, extra = '', attrs?: (i: number) => string) =>
  `<section class="row" data-group="${group}" ${extra}><div class="row-viewport" data-hscroll><div class="row-track">${cards(prefix, n, attrs)}</div></div></section>`;
