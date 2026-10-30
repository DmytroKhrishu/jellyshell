# Web ⇄ Native bridge contract (v1)

The UI is a web app inside a full-screen WebView2. Video is rendered natively by a
`MediaPlayerElement` **behind** the transparent WebView, so the web layer draws overlays
(player controls, subtitles, skip-intro prompt) on top of the video.

Transport: `window.chrome.webview.postMessage(obj)` (web→native) and
`window.chrome.webview.addEventListener('message', e => e.data)` (native→web). Everything is JSON
objects with a `type` field. Unknown types are ignored, never fatal.

When `window.chrome?.webview` is absent (a desktop browser during development), the web app uses a
**mock bridge** that plays the stream in an HTML5 `<video>` and emits the same events.

## web → native

| type | fields | notes |
|---|---|---|
| `hello` | — | native replies `capabilities` |
| `play` | `url`, `itemId`, `startMs`, `container`, `videoCodec`, `audioCodec`, `videoRangeType` (`SDR`/`HDR10`/`HDR10Plus`/`DOVI…`), `width`, `height`, `fps`, `hdr` (`"off"`/`"auto"`), `matchFrameRate` (bool), `audioStreamIndex?` | `url` is whatever Jellyfin PlaybackInfo decided: direct (`static=true`) or HLS transcode/remux (`.m3u8`). Native picks the decoder path. |
| `pause` / `resume` | — | |
| `seek` | `positionMs` | absolute |
| `stop` | `restore?: 'now'` | native tears down the player. With `restore:'now'` (user left the player) the default HDMI mode is restored immediately; without it (episode switch) the playback mode is kept and restored after 5 s idle (or on exit/suspend) |
| `setAudioTrack` | `index` | index into the `tracks.audio` list native sent |
| `setVolume` | `value` 0..1 | app-level volume (MediaPlayer.Volume); TV/CEC volume is NOT controllable from apps |
| `setAudioBoost` | `db` (0/3/6/10), `night` (bool) | audio boost / night mode, live. Also sent inside `play` as `audioBoost: {db, night}`. Native replies `audioBoost`. See "Audio boost" below. |
| `exit` | — | close the app |
| `switchSide` | `side` (`media`/`dash`) | native navigates the single WebView2 to that side's resolved URL (stops playback first). Dash unreachable → `sideUnavailable`, stays put |
| `setStartSide` | `side` (`media`/`dash`) | persisted in LocalSettings `startSide`, used at the next launch |
| `setVideoRect` | `rect: {x, y, w, h} \| null`, `vw`, `vh`, `radius?`, `anim?` | picture-in-picture: put the video in that box (page CSS px; `vw`/`vh` = the page viewport) **above** the WebView; `null` = full window behind it. Native replies `videoRect`. Only when capabilities has `pip: true`. See "Picture in picture" below. |
| `setPipSubs` | `text` (plain, `\n` between lines; `''` = none) | subtitle line drawn over the PiP video (the web layer's subtitles are under it). Only with `pipSubs: true`. |

## native → web

| type | fields | notes |
|---|---|---|
| `capabilities` | `deviceForm`, `hdrDisplay` (bool), `video`: [`h264`,`hevc`,`av1`,`vp9`…], `audioNative`: [...], `audioFfmpeg`: [`truehd`,`dts`…], `containers`: [...], `maxAudioChannels` | facts verified on the console, used by the web app to build the Jellyfin DeviceProfile |
| `playbackState` | `state` (`Opening`/`Buffering`/`Playing`/`Paused`/`Ended`/`Stopped`), `videoWidth?`, `videoHeight?` | |
| `time` | `positionMs`, `durationMs`, `bufferedMs?` | ~4×/s while playing |
| `tracks` | `audio`: [{`index`,`codec`,`channels`,`language`,`title`}] | after open |
| `decoder` | `path` (`mf`/`ffmpeg`), `summary` | diagnostics |
| `error` | `code`, `message`, `fatal` (bool) | |
| `playbackEnded` | — | |
| `audioBoost` | `db`, `night`, `applied` (bool), `path` (`ffmpeg`/`mf`/`webaudio`), `filter?`, `reason?` | ack for `setAudioBoost` / a boosted `play` |
| `videoRect` | `rect` (as sent, or `null`) | ack for `setVideoRect` |
| `sideUnavailable` | `side` (`dash`) | the requested side's page server is unreachable (switch, or start side = dash at launch: sent right after `capabilities`) |

Subtitles are rendered by the **web** layer (Jellyfin WebVTT delivery, synced to `time` events). Native does not render subtitles, except the plain-text line it draws over the PiP window (`setPipSubs`).

Device-side policy (native): system Media Foundation by default (keeps E-AC3/Atmos passthrough and the
HW HEVC/AV1 decoders); FFmpegInteropX only when the audio codec is TrueHD/DTS* or the container/codec combo
fails in MF. With `hdr:"off"`, never switch the HDMI output to HDR (refresh-rate matching still applies if
`matchFrameRate`).

## Native implementation notes (shell 0.1.30+)

- Transport: native sends with `PostWebMessageAsJson`, so `e.data` is already an **object** (not a string).
  Native accepts `postMessage(obj)` and `postMessage(JSON.stringify(obj))`.
- Extra fields beyond v1 (safe to ignore): `capabilities` also has `deviceFamily`, `dolbyVisionLL`, `currentMode`,
  `outputKind`, `modes[]`, `bridgeVersion`; `tracks` has `selected`; `playbackState` `Stopped` carries `positionMs`.
  Native also sends `navigation {ok,status}` and `back {playing}` (B button; the web layer decides, e.g. send `stop`).
- `time.durationMs` is `0` when MF can't tell (progressive remux/transcode streams): use Jellyfin `RunTimeTicks`.
  `bufferedMs` is absent on the FFmpeg path.
- `playbackEnded` is sent only on natural end of media; `stop` from the web answers with `playbackState Stopped`.
- `capabilities.video` = system (MF) decoders found by CodecQuery. **No `av1`** on Series S.
  Native refuses MF for codecs not in that list: a direct AV1 file goes to FFmpeg (`error videoCodecSlow`, non-fatal,
  stutters ~0.7-0.85x at 4K); an AV1 `.m3u8` fails with fatal `videoCodecUnsupported`. DeviceProfile must therefore
  exclude av1 from DirectPlay video codecs so Jellyfin transcodes AV1 to h264 (or hevc) HLS.
- `error.code` values: `openFailed`, `mfOpenFailed`(non-fatal, falling back), `mfFailed`(non-fatal, falling back),
  `mediaFailed`, `videoCodecSlow`, `videoCodecUnsupported`, `badAudioTrack`, `<type>Failed`.
- Debug-only message (not part of v1): `{type:"navigate", url}` makes the WebView load another URL.
- HDMI mode policy (shell 0.1.35+): `hdr:"off"` picks the plain BT.709 variant of the mode (not the ST2084/BT.2020 one)
  with `HdmiDisplayHdrOption.EotfSdr` (`None` on 8-bit modes, which reject EotfSdr), and a watchdog
  (AdvancedColorInfoChanged) re-asserts that mode if the system still flips the output to HDR on HDR10 frames. Native never re-requests the current mode (resolution, refresh
  within 0.01, HDR state), keeps the playback mode after `stop` and restores the default only after 60 s with no new `play`,
  on `exit` or on suspend. Content <=1080 lines on a 1080p output keeps 1080p and only changes the refresh rate.
  Decisions are logged as `display: keep|switch|restore-deferred|restore|probe+3s`.

## 4K UI: not possible (measured on Series S, shell 0.1.36)

The browse UI cannot render at native 4K. UWP XAML (and therefore the WinUI2 WebView2) is composed into a fixed
1920x1080 surface that the console scales to the HDMI output. Measured with the debug message `{type:"displayProbe"}`:

| HDMI output | DisplayInformation | window / XAML | WebView2 JS |
|---|---|---|---|
| 1920x1080@59.94 | RawPixelsPerViewPixel 1, Scale100Percent, LogicalDpi 96, ScreenWidth/HeightInRawPixels 1920x1080 | 1920x1080, RasterizationScale 1 | dpr 1, screen 1920x1080, inner 1920x1080 |
| 3840x2160@59.94 SDR (requested via HdmiDisplayInformation) | identical (still 1920x1080 raw) | identical | identical |

- Portal screenshots are 1920x1080 in both modes, and their edge energy on the tab-bar text is identical (2.628 vs 2.624).
- Supersampling (laying the WebView2 out at 3840x2160 and scaling the element by 0.5, `setUiMode ss:2`): WebView2 ignores
  RenderTransform, so the page drew its top-left quarter at 1:1. GPU went from ~13% to ~58% for nothing. Dead end.
- So a 4K output only swaps who upscales the 1080p UI (Xbox vs TV) and adds a ~5 s HDMI blank on every switch. Not shipped.
  The only native-4K route on Xbox is a DirectX swapchain (games), which a WebView UI can't use.
- Image sizes: keep requesting for a 1920 px-wide layout (backdrops `maxWidth` 1920, cards at their CSS size). Bigger posters
  won't look sharper.

Debug-only messages (not part of v1): `{type:"displayProbe"}` → native replies `displayInfo` and logs `UIMODE probe ...`;
`{type:"setUiMode", mode:"4k"|"1080p", ss:1|2}` switches the HDMI output (and the ss=2 experiment) for testing only. Nothing
reads the stored `uiMode` at startup.

## Audio boost (`setAudioBoost`, shell 0.1.4x+)

`MediaPlayer.Volume` caps at 1.0, so the boost is real DSP:

- **Xbox (native):** FFmpegInteropX's FFmpeg audio filter graph on the decoded PCM. While a boost is active,
  direct-play files open on the FFmpeg path (video stays on the hardware decoder via `ForceSystemDecoder`, same as
  TrueHD/DTS) with `MediaSourceConfig.Audio.FFmpegAudioFilters`; live changes use
  `FFmpegMediaSource.SetFFmpegAudioFilters` / `ClearFFmpegAudioFilters`. Turning the boost on during an MF playback
  reopens the same URL on FFmpeg at the current position (a short rebuffer). Filter chain:
  `[acompressor=threshold=0.0316:ratio=6:attack=5:release=250:makeup=2.8,] volume=<db>dB:precision=float, alimiter=limit=0.891:level=0`
  (night mode = the compressor; limiter at -1 dBFS so +10 dB never clips). The bundled avfilter-11 has
  `volume`/`acompressor`/`alimiter`/`dynaudnorm`/`loudnorm`.
  Side effect: boosted E-AC3/AC3 is decoded to PCM (no bitstream passthrough, no Atmos metadata) while the boost is on.
  HLS transcodes stay on MF and ack `applied:false` (`reason`).
- **Browser (mock bridge):** Web Audio `MediaElementSource → DynamicsCompressor (night) → Gain → limiter → out`,
  built lazily on the first non-neutral boost (`web/src/lib/webaudio.ts`). Not offered on iOS/Safari (native HLS:
  WebKit's MediaElementSource yields silence for HLS).
- The preference is per Jellyfin user in localStorage (`jellyshell.audioBoost.<userId>`), sent with every `play`.

## Picture in picture (`setVideoRect`, capability `pip`)

The web app can shrink the playing video into a floating window while the rest of the UI stays usable
(web/src/lib/pip.ts, components/PipWindow.tsx). In PiP the pages are opaque again (no `html.playing`), so the
video can't show through a transparent hole; instead the shell moves the video **on top**:

- `setVideoRect {rect:{x,y,w,h}, vw, vh, radius}`: native fits the `MediaPlayerElement` into the rect (scaled from
  the page's `vw`×`vh` CSS px to the XAML root), raises it above the WebView (`Canvas.ZIndex`), keeps it out of input
  (`IsHitTestVisible=false`, `IsTabStop=false`: controller focus and keys stay in the WebView) and rounds its top
  corners to `radius` (composition clip; the web's progress line sits right under it). Sent again on page resize.
  Shells with `pipSubs`: the element keeps its full-window layout and is fitted by a render transform (the video
  surface is never resized); older shells resize the element to the rect (and round all four corners).
- `setVideoRect {rect:null}`: back to full window, behind the WebView (the normal player).
- `anim: true` (shells with `pipSubs`): ease from where the video is now to the new rect (`PipAnimMs` 360 ms, transform +
  clip radius, all on the compositor). Older shells ignore it and jump. The web never steps rects itself: each message
  resizes the video on older shells, so stepping stutters.
- The page under the video only switches while the video covers the whole screen above it (web/src/lib/pip.ts
  "Transitions"): enter = rect = whole page (raised, no anim), ack, page switches, window rect with `anim`; leave =
  whole page with `anim` (grows over the browsing page), page switches to the player, then `rect:null` once the
  transparent player page has painted.
- The rect persists across `play`/`stop` (next episode while in PiP keeps the window) until changed.
- Ack: `videoRect {rect}`. Capability flag `pip: true` in `capabilities`; shells without it get no PiP button.
- `setPipSubs {text}` (capability `pipSubs`): native draws the current cue (white on a dark box, bottom of the window)
  above the raised video; hidden while full size or moving. Older shells: no subtitles in PiP (nothing the page draws
  can be above the raised video).
- Display mode: entering PiP does **not** restore the TV's default refresh rate (an HDMI mode switch blanks the
  screen for seconds and would interrupt the video). With Match frame rate the browsing UI can run at the film's
  23.976 Hz while PiP is up (menus feel less smooth); leaving the player restores it as usual (`stop {restore:'now'}`).
- Browser mock: the same messages position `#mock-video` (inline styles, `pointer-events:none`; `anim` = a FLIP
  transform animation), draw `#mock-pip-subs`, and emit `videoRect`.

## Sides: media + dash in one app (shell 0.1.5x+ / store 1.0.x, docs/store-release.md)

- `capabilities` (the hello reply) also carries `side` (`media`/`dash`, what is loaded now), `startSide`,
  `sides: {media: true, dash: <bool, a dash page server answered>}` and `uiSource`
  (`saved`/`default`/`public`/`bundled`/`none`; shells before the open-source scrub sent `lan`/`public`/`bundled`).
  An OLD shell sends none of these: hide the Dash pill when `sides` is absent.
- Resolution per side, at launch and on every `switchSide` (shell/XboxShell/UiSource.cs). Nothing is hard-coded:
  - media: 1. the address the user saved (`setUiServer`, LocalSettings `uiServer.media`) → 2. the build-time media default →
    3. the build-time public default → 4. the bundled UI. Each address is probed with a GET (2.5 s for http, 4 s for https);
    the first that answers wins.
  - dash: 1. saved (`uiServer.dash`) → 2. build-time dash default → none (dash side unavailable).
  - Build-time defaults are optional and come from `JELLYSHELL_MEDIA_URL` / `JELLYSHELL_DASH_URL` / `JELLYSHELL_PUBLIC_URL`
    (CI secrets or variables, or msbuild `/p:JellyShellMediaUrl=...`), generated into `obj\...\BuildDefaults.g.cs` by
    XboxShell.csproj. A plain local build has none (docs/building.md).
  - Bundled: `web/dist` (packaged under `ui\`, CI-built) via
     `SetVirtualHostNameToFolderMapping("app.jellyshell", ...)` → `http://app.jellyshell/index.html` (http on purpose: an https origin cannot fetch the LAN Jellyfin over http, mixed content; the mapping serves both schemes, the web side treats host `app.jellyshell` as bundled).
     No page server there: `api/config`, `log`, Requests/Downloads/subtitles/picture are gone and the UI must degrade quietly.
- Launch resolves both sides in parallel. Start side dash + dash down → media loads and
  `sideUnavailable {side:'dash'}` follows the first `capabilities`.
- Native log lines (`NATIVE ...` POST `log`) go to the resolved MEDIA page server (relative path, so a sub-path like
  `/jellyshell/` is kept), even while the dash side is shown; in bundled mode they are dropped silently.
- Still one WebView2: switching just navigates it (≈180 MB headroom, no second instance).

## UI servers: user-set page-server addresses (Xbox shell)

So a build without (or with the wrong) build-time defaults can still reach a JellyShell page server.
- `capabilities.uiServers = {media: string|null, dash: string|null, defaults: {media: string|null, dash: string|null}}`:
  the addresses the user saved (null = none) and the build-time defaults (media = media default, else public default).
  Absent on older shells and on Android: the web hides the setting.
- web → native `{type:'setUiServer', side:'media'|'dash', url: string|null}`. `url` = absolute http(s) address of the page
  server (path allowed, e.g. `https://media.example.com/jellyshell/`); `null` or `''` clears the saved one.
  Native normalizes it (no credentials/query/fragment, path ends in `/`), probes it (same GET as the launch resolution) and
  only saves it when it answers, so a typo can't strand the app on a dead page.
- native → web `{type:'uiServer', side, ok: true, url: string|null, uiServers}` after saving/clearing, or
  `{type:'uiServer', side, ok: false, url, error: string, uiServers}` (invalid address / nothing answered; nothing saved).
- After `ok:true` the shell re-resolves that side. If it is the side on screen, the WebView navigates to the new source
  (a playing video is stopped first), so the page that sent the message goes away; for the other side only the
  resolution (dash reachability / log target) is updated.
- Web: `web/src/lib/uiservers.ts` (`uiServers` signal, `setUiServer()` with a 10 s answer timeout), Settings rows
  "JellyShell server" / "Dash server" (`components/UiServerDialog.tsx`) and the optional second field in the bundled
  first-run `components/ServerSetup.tsx`. Desktop mock: `?uiservers=1` (accepts anything without "bad" in it).
