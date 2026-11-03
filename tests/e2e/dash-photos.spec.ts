// Dash Photos (1920x1080, every /api call mocked). Regression: the last photo in a row stopped under the screen edge,
// because dash/web/src/lib/focus.ts still bounded the row by track.scrollWidth after the media side had moved to hMax()
// (fixed in 728109e). The focus engine unit tests run on the dash copy too; this checks the real page and CSS.
import { test, expect } from '@playwright/test';
import { DASH, PNG, lockNetwork, pageServer } from './net';
import { frames, settledRect } from './util';

const photos = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, taken: '2024-06-01T12:00:00', place: 'Nowhere' }));
const OFF = { calendar: false, home: false, music: false, weather: false, server: false };

test('dash Photos: Right to the end of a row keeps the last photo inside the safe edge', async ({ page }) => {
  const net = await lockNetwork(page.context(), DASH, [
    (url) => (url.origin === DASH && url.pathname.startsWith('/api/photo/') ? { body: PNG, contentType: 'image/png' } : undefined),
    pageServer(DASH, [], {
      '/api/config': { timeZone: 'Europe/Prague', features: { ...OFF, photos: true } },
      '/api/photos': { memories: [{ title: '1 year ago', assets: photos('m', 12) }], favorites: photos('f', 12), random: [] },
      '/api/backdrops': [],
      '/api/settings': {},
    }),
  ]);
  await page.goto(`${DASH}/?idle=0#photos`);
  const row = page.locator('.photos-page .row-track').first();
  const cardsInRow = row.locator('.card');
  await expect(cardsInRow).toHaveCount(12, { timeout: 20_000 });
  // Focus starts on the first photo, or on the Photos tab when the keep-focus timer ran before the photos arrived: then
  // Down enters the page, as on the TV.
  const inTabBar = () => page.evaluate(() => !!document.activeElement?.closest('.tabbar'));
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.tabbar, .photos-page'))).toBe(true);
  if (await inTabBar()) {
    await frames(page);
    await page.keyboard.press('ArrowDown');
  }
  await expect(cardsInRow.first()).toBeFocused();
  await frames(page);

  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowRight');
  await expect(cardsInRow.last()).toBeFocused();
  await cardsInRow.last().evaluate((el) => el.setAttribute('data-test-last', ''));
  const r = await settledRect(page, '[data-test-last]');
  expect(r.right, 'last photo (focused, scaled) inside the 1840 px safe edge').toBeLessThanOrEqual(1920 - 80 + 0.5);
  expect(r.right, 'and the row is not scrolled past its end').toBeGreaterThan(1840 - 60);
  expect(net.writes).toEqual([]);
});
