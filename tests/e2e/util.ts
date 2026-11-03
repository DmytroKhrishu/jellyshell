import { expect, type Page } from '@playwright/test';

export const focusedKey = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.fkey ?? null);

/** Let already-scheduled requestAnimationFrame callbacks run (the app remembers/focuses in rAFs), like a human pause
 *  before the next press. A busy CI machine can otherwise deliver the key before those frames. */
export const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Rect of `sel` once its row has finished scrolling: the track's animated translate equals the target the focus engine
 * set (data-tx). Comparing two reads in a row isn't enough on a busy machine, where a starved animation can look still.
 */
export async function settledRect(page: Page, sel: string) {
  await expect
    .poll(
      () =>
        page.evaluate((s) => {
          const track = document.querySelector(s)!.closest('[data-hscroll]')!.firstElementChild as HTMLElement;
          const t = getComputedStyle(track).transform;
          const x = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0;
          return Math.abs(x + Number(track.dataset.tx || 0)) < 0.5;
        }, sel),
      { message: `${sel}: row scroll animation never reached its target`, timeout: 10_000 },
    )
    .toBe(true);
  return page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), sel) as Promise<DOMRect>;
}
