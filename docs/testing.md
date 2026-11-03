# Tests

One command at the repo root:

```sh
npm test
```

It installs whatever is missing (root, `web/`, `dash/web/` node_modules and a headless Chromium, via `tests/setup.mjs`),
then runs everything in about 15 s. CI runs the same command as the first job of `.github/workflows/build.yml`.

| Command | What |
|---|---|
| `npm test` | all of the below |
| `npm run test:focus` | focus engine unit tests + copy parity guard (no servers) |
| `npm run test:e2e` | headless app screens on Vite dev servers |
| `npm run test:py` | dash server tests (`dash/server/test_*.py`) |
| `npx playwright test -g 'series'` | one test by name |
| `npx playwright show-trace test-results/<test>/trace.zip` | step through a failed test (CI uploads `test-results` as an artifact) |

## What is covered

### Focus engine (`tests/focus/`)
The D-pad engine exists twice: `web/src/lib/focus.ts` (media) and `dash/web/src/lib/focus.ts` (Dash). Every test in
`engine.spec.ts` runs against **both** copies in real Chromium layout (1920×1080, app row CSS), so a fix made in one copy
and not the other fails.

- `move()`: rows, group memory, `[data-lastresort]` tab bar, `[data-block]`, `[data-scope]` dialogs.
- `remember()`: Down from the series header lands on the selected (up-next) season pill, not Season 1.
- `rowEntry()`: Down from a search field or a pill row into a never-visited row lands on the row's `[data-autofocus]` card
  (up-next episode) or its first card, never mid-list; row-to-row moves stay geometric.
- `hMax()`: focusing the last card keeps it inside the 1840 px safe edge, the shift is larger than the old
  `scrollWidth` bound (the fixture proves it would have failed), wheel scrolling stops at the same bound, and a track
  sitting inside its viewport's padding (episodes-panel season pills) keeps its last pill unclipped.

Features that exist in one copy on purpose are listed in `ONLY` (`tests/focus/harness.ts`) with the reason. Their tests
run on that copy only and show as skipped on the other.

`parity.spec.ts` compares the two files function by function (comments and whitespace ignored). A function that is in
both copies must have the same body, unless it is in `DIVERGENT` with a reason (`move`, `reveal`, `wheelScroll`,
`resetScroll` today). A helper added to only one copy fails unless it is in `ONE_SIDED`. So when you fix
`hMax` in `web/`, the suite tells you to port it to `dash/web/`.

### App screens (`tests/e2e/`)
Vite dev servers on 127.0.0.1:5391 (media) and :5392 (Dash), ports overridable with `JS_TEST_WEB_PORT` /
`JS_TEST_DASH_PORT`. Every request goes through `lockNetwork()` (`tests/e2e/net.ts`): Vite assets pass, mocked endpoints
are answered, and everything else is aborted. Jellyfin is a fake at `http://jf.test` (`mock-jellyfin.ts`), the page
server's `/api/*` and `/log` are mocked, and the dev servers' API proxies point nowhere. No test can reach a live
JellyShell, Dash, Jellyfin or Seerr, and the series test also asserts that no write request (watched, favorite, progress)
was sent.

- `series.spec.ts` (media, `?mode=tv`, 1920×1080): a show with four seasons and Next Up = S3E05, with Next Up answering
  1.5 s after the seasons. Down from Play lands on Season 3 (not Season 1). Season 3 stays selected, the next Down lands on
  S3E05 (not mid-list), and Right to the last episode keeps that card inside the safe edge. A second test checks the
  same flow when Next Up answers first.
- `dash-photos.spec.ts` (Dash): Photos with 12 photos in a row. Right to the last one keeps it inside the safe edge.

## When a bug comes back
Add a test for it here before (or with) the fix, run `npm test`, and keep it green. Focus and scroll bugs belong in
`tests/focus/engine.spec.ts`, where they run on both engine copies automatically. Screen-level regressions go in
`tests/e2e/` with mocked data only.

## Not covered
- The Xbox itself: WebView2 gamepad keyCodes (195+), native video, HDMI modes. The tests drive arrow keys in Chromium.
- Pages without tests yet: Home hero, Search, Requests, the player and its episodes panel (the panel's padding case is
  covered at engine level), Dash tabs other than Photos.
- Visual looks (no screenshot diffs).
