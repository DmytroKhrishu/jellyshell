// Series page in the media app (TV mode, 1920x1080, fake Jellyfin). Regressions:
//  - b3f7500: Down from the header landed on Season 1 instead of the up-next season (remember(pill) in SeriesBody)
//  - 28e3545: the season was picked before Next Up arrived (Season 1), and Down into the episode row landed mid-list
//  - hMax: the last episode card stopped under the screen edge
import { test, expect, type Page } from '@playwright/test';
import { WEB, JF, lockNetwork, pageServer } from './net';
import { mockJellyfin, authInit, SERIES, UP_NEXT } from './mock-jellyfin';
import { focusedKey, frames, settledRect } from './util';

async function openSeries(page: Page, nextUpDelayMs: number) {
  const net = await lockNetwork(page.context(), WEB, [pageServer(WEB, [{ open: SERIES }], { '/api/config': {} }), mockJellyfin({ nextUpDelayMs })]);
  await page.addInitScript(authInit, JF);
  await page.goto(`${WEB}/?mode=tv&remote=e2e`);
  await expect(page.locator('[data-fkey="act-play"]')).toBeFocused({ timeout: 20_000 });
  return net;
}

test('series page: Down from the header -> up-next season -> up-next episode; the last episode card fits the screen', async ({ page }) => {
  // Next Up answers well after the seasons: the old code picked Season 1 as soon as the seasons arrived.
  const net = await openSeries(page, 1500);
  await expect(page.locator(`[data-fkey="ep-${UP_NEXT}"]`), 'the up-next episode is in the row (its season was selected)').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.season-pill.selected')).toHaveAttribute('data-fkey', 'season-S3');

  await frames(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedKey(page), { message: 'Down from Play lands on the selected season, not Season 1' }).toBe('season-S3');
  await expect(page.locator('.season-pill.selected')).toHaveAttribute('data-fkey', 'season-S3');

  await frames(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedKey(page), { message: 'Down from the season lands on the up-next episode, not mid-list' }).toBe(`ep-${UP_NEXT}`);

  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedKey(page)).toBe('ep-S3E12');
  const r = await settledRect(page, '[data-fkey="ep-S3E12"]');
  expect(r.right, 'last episode card (focused, scaled) inside the 1840 px safe edge').toBeLessThanOrEqual(1920 - 80 + 0.5);
  expect(r.right, 'and the row is not scrolled past its end').toBeGreaterThan(1840 - 60);

  expect(net.writes, 'no mutations sent (watched/favorite/progress)').toEqual([]);
});

test('series page: Next Up answering first gives the same result', async ({ page }) => {
  await openSeries(page, 0);
  await expect(page.locator(`[data-fkey="ep-${UP_NEXT}"]`)).toBeVisible({ timeout: 10_000 });
  await frames(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedKey(page)).toBe('season-S3');
});
