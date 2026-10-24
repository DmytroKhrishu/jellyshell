# JellyShell for Android (TV + phone)

A thin WebView wrapper (`android/`) around the same web UI the Xbox uses, loaded from your JellyShell page server.
The address is the one saved on the device, else the build-time `JELLYSHELL_DEFAULT_URL` (gradle property or env, e.g.
a public reverse-proxied `https://media.example.com/jellyshell/` so it works outside the LAN). A build without a default
asks for the address on first launch ("Set up JellyShell"; backing out leaves the app).

## What the wrapper does
- Single Kotlin activity, full-screen WebView, leanback launcher entry + 320×180 banner (`docs/store/art/src/android.mjs`).
- Hardware acceleration on, autoplay without a user gesture, DOM storage (login persists).
- Remote: D-pad/OK reach the page as arrows/Enter (Chromium does that itself). **Back** becomes keydown/keyup
  `Escape` (27) = the app's `back` action in `web/src/lib/input.ts`. Back at Home root does nothing (the app never
  exits on B, same as Xbox); use the TV's Home button.
- UA gets `JellyShellTV/<version>`. The web UI keys off it: TV layout (`lib/mode.ts isAndroidTV`), no desktop
  arrow-key seeking in the player, device name "Android TV", and an HEVC remux profile (below).
- Change the server address: press **Back 5× within 2 s**, or pick "Change address" on the error dialog if the
  page can't load. Debug: `adb shell am start -n <applicationId>/app.jellyshell.MainActivity --es url <URL>`.
  WebView remote debugging is on (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`).

## Playback
Playback is the browser path: PlaybackInfo with the browser DeviceProfile → hls.js → `<video>` (Android WebView MSE).
- MSE can't read MKV, and AC3/EAC3/DTS/TrueHD aren't decodable in WebView, so nearly every file is at least
  **remuxed** with audio converted to stereo AAC (no surround passthrough).
- For JellyShellTV the profile adds an fMP4 HLS transcoding profile with `hevc,h264`, so SDR HEVC Main (and Main10
  when `isTypeSupported('hvc1.2.4…')` says yes) is **copied**, not re-encoded. Verified: before = `h264_qsv` full
  encode; after = `codec:v:0 copy`, `hls_segment_type fmp4`.
- HDR/Dolby Vision 4K is tone-mapped and re-encoded server-side (heavy; the i5-9400T manages roughly 1-2 streams).
- For big 4K HDR/Atmos use, the official Jellyfin Android TV app (ExoPlayer, Play Store) is the better player.

## Build
How-to (local + CI, keystore, options): docs/building.md. In short:
- Kotlin package / namespace `app.jellyshell`. applicationId = `JELLYSHELL_APP_ID` (default `app.jellyshell`) + `.tv` /
  `.mobile`. Keep it, and the signing key, stable: Android only updates an install with the same id and key.
- `.github/workflows/build-android.yml` (push to `android/**` or manual) → artifacts `jellyshell-tv-apk` + `jellyshell-android-apk`,
  signed with the stable release key from secrets `ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASSWORD` (alias `jellyshell`;
  debug-signed without them). Keep a private backup of the keystore and never regenerate it: a different key means the
  TV refuses to update and the app must be uninstalled first. versionCode = GitHub run number.
- Local: `cd android && ./gradlew assembleTvRelease assembleMobileRelease [-PJELLYSHELL_DEFAULT_URL=... -PJELLYSHELL_APP_ID=...]`.

## Distribution
`web-poc/server.py` serves the APKs dropped into its data dir's `apk/` folder (gitignored) at `/tv.apk` and
`/android.apk` on both listeners, e.g. `https://media.example.com/jellyshell/tv.apk` behind a public reverse proxy.

## Phone / tablet flavor (`mobile`)

Same activity, `android/app/src/{tv,mobile}` flavors. `mobile` = applicationId `<JELLYSHELL_APP_ID>.mobile`
(installs next to the TV app), UA marker `JellyShellMobile/` → web UI goes to `mode-mobile touch`.
- System bars visible; page padded by system-bar/cutout/IME insets (targetSdk 35 is edge-to-edge).
- Player fullscreen button → WebChromeClient custom view, immersive + sensor-landscape; Back / exit → portrait-capable again.
- Back: fullscreen → exit; open sheet/dialog → Escape; else `WebView.goBack()` (mobile UI mirrors routes into
  history + popstate); at root → `moveTaskToBack` (app backgrounds, like any phone app).
- Settings: long-press icon → "Server address" (static shortcut, action `app.jellyshell.SETTINGS`;
  `res/xml/shortcuts.xml` is generated per variant by `app/build.gradle.kts` because the intent's `targetPackage` must be the
  literal applicationId: launchers don't resolve a `@string` there and manifest placeholders don't reach res/xml), or the error dialog.
- Off-site links (IMDb/TMDB/trailers) open in the system browser.
- Same release key as TV. CI artifact `jellyshell-android-apk`; served at `/android.apk`.
- Tested 2026-10-23 on a Pixel 7 AVD (API 35, WebView 124): login + keyboard, tabs, detail → Back, More sheet → Back,
  root Back backgrounds, 4K playback + fullscreen landscape + Back out, shortcut dialog.
