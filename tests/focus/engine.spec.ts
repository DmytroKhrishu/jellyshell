// Focus engine unit tests, run against BOTH copies (media web/src/lib/focus.ts and dash/web/src/lib/focus.ts).
// Regressions covered (see docs/testing.md):
//  - remember(): Down from the series header lands on the selected (up-next) season pill, not Season 1 (b3f7500)
//  - rowEntry(): Down from a field/pills into a never-visited row lands on its marked or first card, not mid-list (28e3545)
//  - hMax(): the last card of a row stops inside the TV-safe edge (scrollWidth drops the end padding; dash until 728109e),
//    and a track that sits inside its viewport's padding (episodes-panel season pills, 728109e)
import { test, expect, type Page } from '@playwright/test';
import { COPIES, ONLY, load, press, focus, focused, rect, row, type Copy } from './harness';

/** Skip on the copy that deliberately lacks `feature` (see ONLY in harness.ts). */
function onlyIn(copy: Copy, feature: keyof typeof ONLY) {
  const o = ONLY[feature];
  test.skip(o.copy !== copy.name, `${feature} is ${o.copy}-only: ${o.why}`);
}

// Series-page-like layout: tab bar, header buttons, season pills, episodes row, cast row.
const seriesPage = (opts: { autofocus?: number } = {}) => `
  <nav class="tabbar" data-lastresort>${['home', 'movies', 'shows', 'search'].map((t) => `<div class="tab focusable" data-fkey="tab-${t}"></div>`).join('')}</nav>
  <div class="page-pad">
    <div class="btn-row" data-group="actions"><div class="btn focusable" data-fkey="play"></div><div class="btn focusable" data-fkey="fav"></div></div>
    <div class="pills" data-group="seasons" style="margin-top:40px">${[1, 2, 3, 4, 5].map((s) => `<div class="pill focusable" data-fkey="s${s}"></div>`).join('')}</div>
    ${row('eps', 'ep', 14, '', (i) => (i === opts.autofocus ? 'data-autofocus' : ''))}
    ${row('cast', 'c', 14)}
  </div>`;

const lastCardFits = async (page: Page, key: string, edge = 1920 - 80) => {
  const r = await rect(page, key);
  expect(r.right, `${key} right edge (focused, scaled) must stay inside the safe edge ${edge}`).toBeLessThanOrEqual(edge + 0.5);
  return r;
};

for (const copy of COPIES) {
  test.describe(`${copy.name} (${copy.file})`, () => {
    test.describe('move()', () => {
      test('Left/Right walk a row', async ({ page }) => {
        await load(page, copy, seriesPage());
        await focus(page, 'ep3');
        expect(await press(page, 'right')).toBe(true);
        expect(await focused(page)).toBe('ep4');
        await press(page, 'left');
        await press(page, 'left');
        expect(await focused(page)).toBe('ep2');
      });

      test('remember(): Down from the header enters the pill group on the remembered (selected) pill, not the nearest one', async ({ page }) => {
        await load(page, copy, seriesPage());
        await focus(page, 'play');
        await page.evaluate(() => (window as any).F.remember(document.querySelector('[data-fkey="s4"]')));
        expect(await focused(page), 'remember() must not move focus').toBe('play');
        await press(page, 'down');
        expect(await focused(page)).toBe('s4');
      });

      test('without remember() the same Down picks the nearest pill (the Season 1 bug: fixture still reproduces it)', async ({ page }) => {
        await load(page, copy, seriesPage());
        await focus(page, 'play');
        await press(page, 'down');
        expect(await focused(page)).toBe('s1');
      });

      test('re-entering a visited row restores its last focused card', async ({ page }) => {
        await load(page, copy, seriesPage({ autofocus: 6 }));
        await focus(page, 'ep9');
        await press(page, 'up');
        expect(await focused(page)).toMatch(/^s\d$/);
        await press(page, 'down');
        expect(await focused(page)).toBe('ep9');
      });

      test('Up prefers page content over the tab bar ([data-lastresort]) and reaches the tabs only from the top', async ({ page }) => {
        await load(page, copy, seriesPage());
        await focus(page, 's1');
        await press(page, 'up');
        expect(await focused(page)).toBe('play');
        await press(page, 'up');
        expect(await focused(page)).toMatch(/^tab-/);
      });

      test('[data-block] keeps focus in a short row instead of jumping diagonally into the row above', async ({ page }) => {
        const html = (block: boolean) => `<div class="page-pad">${row('long', 'l', 8)}${row('short', 's', 2, block ? 'data-block="left right"' : '')}</div>`;
        await load(page, copy, html(false));
        await focus(page, 's2');
        await press(page, 'right');
        expect(await focused(page), 'fixture: without the block Right escapes into the long row').toMatch(/^l\d$/);
        await load(page, copy, html(true));
        await focus(page, 's2');
        expect(await press(page, 'right')).toBe(false);
        expect(await focused(page)).toBe('s2');
      });

      test('[data-scope] traps focus inside the newest visible scope (dialogs)', async ({ page }) => {
        await load(page, copy, `${seriesPage()}<div data-scope style="position:absolute;left:700px;top:400px"><div class="btn focusable" data-fkey="ok"></div><div class="btn focusable" data-fkey="cancel" style="margin-top:20px"></div></div>`);
        await focus(page, 'ok');
        await press(page, 'down');
        expect(await focused(page)).toBe('cancel');
        expect(await press(page, 'down')).toBe(false);
        expect(await press(page, 'left')).toBe(false);
        expect(await focused(page)).toBe('cancel');
      });
    });

    test.describe('rowEntry(): entering a never-visited row from outside any row', () => {
      test.beforeEach(() => onlyIn(copy, 'rowEntry'));

      test('Down from a wide search field lands on the first card, not the one under the field centre', async ({ page }) => {
        await load(page, copy, `<div class="page-pad"><div class="btn focusable" data-fkey="field" style="width:1400px"></div>${row('res', 'r', 10)}</div>`);
        await focus(page, 'field');
        await press(page, 'down');
        expect(await focused(page)).toBe('r1');
      });

      test('Down from a season pill lands on the row\'s [data-autofocus] card (up-next episode), not mid-list', async ({ page }) => {
        await load(page, copy, seriesPage({ autofocus: 6 }));
        await focus(page, 's5');
        await press(page, 'down');
        expect(await focused(page)).toBe('ep6');
      });

      test('no [data-autofocus]: first card', async ({ page }) => {
        await load(page, copy, seriesPage());
        await focus(page, 's5');
        await press(page, 'down');
        expect(await focused(page)).toBe('ep1');
      });
    });

    test('row to row stays geometric: Down from the last card of a row keeps the column (no rowEntry)', async ({ page }) => {
      await load(page, copy, seriesPage());
      await focus(page, 'ep14'); // scrolled to the end: ep14 sits at the right edge
      const from = await rect(page, 'ep14');
      const before = await page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-group="cast"] .card')].map((c) => [c.dataset.fkey, c.getBoundingClientRect().toJSON()])),
      );
      await press(page, 'down');
      const to = await focused(page);
      expect(to).toMatch(/^c\d+$/);
      expect(to).not.toBe('c1');
      const r = before[to!]; // where the target sat when Down was pressed (focusing it scrolls the cast row)
      expect(r.right > from.left && r.left < from.right, `${to} ${JSON.stringify(r)} overlaps ep14 ${JSON.stringify(from)}`).toBe(true);
    });

    test('far rule: Up into another column ranks below the tab bar (Overview: Calendar -> tabs, not Now Playing)', async ({ page }) => {
      onlyIn(copy, 'far');
      await load(
        page,
        copy,
        `<nav class="tabbar" data-lastresort><div class="tab focusable" data-fkey="tab-a"></div></nav>
         <div class="card focusable" data-fkey="cal" style="position:absolute;left:80px;top:300px;width:800px;height:400px"></div>
         <div class="card focusable" data-fkey="np" style="position:absolute;left:1000px;top:120px;width:800px;height:120px"></div>`,
      );
      await focus(page, 'cal');
      await press(page, 'up');
      expect(await focused(page)).toBe('tab-a');
    });

    test('move(dir, quiet) does not bump at an edge', async ({ page }) => {
      onlyIn(copy, 'quiet');
      await load(page, copy, `<div class="page-pad"><div class="btn focusable" data-fkey="only"></div></div>`);
      await focus(page, 'only');
      expect(await press(page, 'up', true)).toBe(false);
      expect(await page.evaluate(() => document.querySelector('[data-fkey="only"]')!.className)).not.toContain('bump');
      await press(page, 'up');
      expect(await page.evaluate(() => document.querySelector('[data-fkey="only"]')!.className)).toContain('bump-up');
    });

    test.describe('hMax(): horizontal row scrolling', () => {
      test('focusing the last card keeps it inside the TV-safe edge at 1920x1080', async ({ page }) => {
        await load(page, copy, seriesPage());
        // The old bound, track.scrollWidth - clientWidth, must really be short here, or this fixture proves nothing.
        const old = await page.evaluate(() => {
          const h = document.querySelector<HTMLElement>('[data-group="eps"] [data-hscroll]')!;
          return (h.firstElementChild as HTMLElement).scrollWidth - h.clientWidth;
        });
        await focus(page, 'ep14');
        const tx = await page.evaluate(() => Number(document.querySelector<HTMLElement>('[data-group="eps"] .row-track')!.dataset.tx));
        expect(tx, 'shift must exceed the old scrollWidth bound').toBeGreaterThan(old);
        const r = await lastCardFits(page, 'ep14');
        expect(r.right, 'and not scroll past the end (no big empty gap after the last card)').toBeGreaterThan(1840 - 30);
      });

      test('focusing a card in the middle aligns it to the safe edge; a short row never scrolls', async ({ page }) => {
        await load(page, copy, `<div class="page-pad">${row('a', 'a', 14)}${row('b', 'b', 3)}</div>`);
        await focus(page, 'a5');
        expect((await rect(page, 'a5')).left).toBeCloseTo(80 - 300 * 0.04, 0);
        await focus(page, 'b3');
        expect(await page.evaluate(() => document.querySelectorAll<HTMLElement>('.row-track')[1].dataset.tx)).toBe('0');
      });

      test('mouse wheel scrolling stops at the same bound', async ({ page }) => {
        await load(page, copy, seriesPage());
        await page.evaluate(() => (window as any).F.wheelScroll(document.querySelector('[data-fkey="ep2"]'), 99999, 0, false));
        const r = await rect(page, 'ep14');
        expect(r.right).toBeLessThanOrEqual(1840 + 0.5);
        expect(r.right).toBeGreaterThan(1840 - 30);
      });

      test('a track that sits inside its viewport padding (episodes-panel season pills) keeps the last pill unclipped', async ({ page }) => {
        // .epp-seasons { margin: 0 -1rem; padding: 0 1rem; overflow: hidden } > .epp-seasons-track { display: flex; gap: .6rem }
        await load(
          page,
          copy,
          `<div style="position:absolute;left:1300px;top:100px;width:540px">
             <div data-hscroll data-group="epp" style="margin:0 -16px;padding:0 16px;overflow:hidden">
               <div style="display:flex;gap:10px;padding:6px 0">${Array.from({ length: 8 }, (_, i) => `<div class="pill focusable" data-fkey="p${i + 1}" style="flex:none;width:120px"></div>`).join('')}</div>
             </div>
           </div>`,
        );
        await focus(page, 'p8');
        const r = await rect(page, 'p8');
        const clip = await page.evaluate(() => document.querySelector('[data-hscroll]')!.getBoundingClientRect().right);
        expect(r.right, 'last pill right edge vs the clipping viewport').toBeLessThanOrEqual(clip + 0.5);
      });
    });
  });
}
