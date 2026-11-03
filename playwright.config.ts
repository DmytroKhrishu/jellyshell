// `npm test` at the repo root. Projects:
//   focus: focus-engine unit tests against both copies (web/ and dash/web/), plus the copy parity guard
//   e2e:   headless app screens (series seasons, row ends, Dash Photos) on Vite dev servers with ALL network mocked
// Details: docs/testing.md
import { defineConfig } from '@playwright/test';

export const WEB_PORT = Number(process.env.JS_TEST_WEB_PORT) || 5391;
export const DASH_PORT = Number(process.env.JS_TEST_DASH_PORT) || 5392;
const e2e = !process.argv.some((a) => a === '--project=focus');

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: 'test-results',
  use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, trace: 'retain-on-failure' },
  projects: [
    { name: 'focus', testDir: 'tests/focus' },
    { name: 'e2e', testDir: 'tests/e2e', timeout: 45_000 },
  ],
  // Dev servers on their own ports with the page-server proxies pointed nowhere (the tests mock every /api call in the
  // browser anyway): nothing can reach a live JellyShell, Dash or Jellyfin.
  webServer: e2e
    ? [
        { command: 'npx vite', cwd: 'web', url: `http://127.0.0.1:${WEB_PORT}/`, env: { VITE_HOST: '127.0.0.1', VITE_PORT: String(WEB_PORT), JELLYSHELL_DEV_API: '' }, reuseExistingServer: false, timeout: 60_000 },
        { command: 'npx vite', cwd: 'dash/web', url: `http://127.0.0.1:${DASH_PORT}/`, env: { VITE_HOST: '127.0.0.1', VITE_PORT: String(DASH_PORT), DASH_DEV_API: 'http://127.0.0.1:9' }, reuseExistingServer: false, timeout: 60_000 },
      ]
    : undefined,
});
