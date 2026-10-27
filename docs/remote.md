# Phone remote

A web page for phones (`/remote` on the JellyShell page server) that drives one JellyShell screen: swipe pad or D-pad,
LB/RB/LT/RT, A/B/X/Y, View/Menu, play/pause, and typing into the TV's focused text field. It replaces the Xbox app's
remote, which goes phone → Microsoft cloud → console and lags.

## Pairing

Pairing is between **instances**, not Jellyfin accounts: one phone controls one console/browser, whoever is signed in.

1. The TV (any signed-in JellyShell UI served by a page server) creates a host identity on first use: a random id + secret
   in `localStorage` (`jellyshell.remoteHost`). Registering it (`POST /api/remote/host`) needs a valid Jellyfin token, so
   strangers can't fill the relay.
2. Settings → Remote → **Phone remote** shows a 6-digit code (valid 10 minutes, one live code per host) and a QR code for
   `<page server>/remote#<code>`. Scanning the QR pairs straight away; otherwise the phone page asks for the code.
3. `POST /api/remote/pair {code, name}` returns a random remote token bound to that host only. The server stores only
   SHA-256 hashes of host secrets and tokens, in `$JELLYSHELL_DATA_DIR/remote.json`. Up to 12 phones per host (the least
   recently used is dropped).
4. The phone keeps the token in `localStorage` and a cookie. iOS copies Safari's cookies (not its storage) into a Home
   Screen web app when it's created, so pairing in Safari and then Share → Add to Home Screen keeps the pairing.
5. Unpair from the phone (⋯ → Unpair) or from the TV dialog (Paired phones → Remove).

Code guessing is rate-limited per IP (burst 8, then one try per 5 s) and globally (pairing pauses after 60 failures in
10 minutes). A code is single-use.

## Transport

No WebSockets: Tailscale Funnel only speaks HTTP/2 to browsers, where WebSocket needs RFC 8441 (the stdlib server can't).
Plain HTTP long polls work through every proxy we support.

- Phone → TV: `POST /api/remote/send {cmds:[...]}` (header `X-Remote-Token`). The phone keeps one request in flight and
  batches whatever queued meanwhile, so order is kept.
- TV ← relay: the TV long-polls `GET /api/remote/poll?since=<seq>` (headers `X-Remote-Host`, `X-Remote-Key`), held up to
  25 s and answered the moment a command arrives (~3-4 ms relay time on the LAN). Undelivered presses older than 4 s are
  dropped (a TV that reconnects never replays a burst); releases (`t:'up'`) are always delivered.
- TV → phone: the TV posts a small state (`POST /api/remote/state`: focused text field label/value, now playing) and the
  phone long-polls `GET /api/remote/watch?v=<n>`; it also reports whether the TV is polling (online dot / "isn't listening").
- The TV only polls while at least one phone is paired or the pairing dialog is open.
- The public listener (`JELLYSHELL_PUBLIC_PORT`) serves the same relay and page: a phone on the funnel URL can drive a
  TV loaded from the LAN URL (one process, shared state). `/api/remote/*` has its own per-IP limits there instead of the
  general write bucket.

Commands: `{a:<action>, t:'tap'|'down'|'up'}` (actions as in lib/input.ts), `{text:<full field value>}`,
`{key:'enter'|'clear'}`, `{playpause:true}`, `{player:{op,...}}` (below). The relay validates every command and clamps
every number (`_player()` in web-poc/remote_relay.py); unknown ops and extra fields are dropped before they reach the TV.

| op | payload | TV runs |
|---|---|---|
| `pp` / `play` / `pause` | | the play/pause button |
| `seek` / `skip` | `ms` (0..24 h / ±10 min) | the seek bar / the skip buttons |
| `audio` / `sub` | `i` (stream index, `sub` -1 = off) | the Audio & Subtitles dialog's pick (track memory, toasts) |
| `subOff` | `d` = -500 / 0 (reset) / 500 | the dialog's subtitle timing row |
| `boost` / `night` | `db` (0..20) / `on` | the Audio boost dialog (persisted per user) |
| `pic` | `b` (0..100) and/or `c` (0.5..2) | the Picture dialog (server-side tone mapping, stream restart) |
| `next` / `skipSeg` / `ep` | `ep`: 32-hex item id | Next episode / the Skip Intro button / the episode list |

The state is capped at 32 KB (`MAX_STATE`); the TV drops the episode list, then trims track lists to 20, to fit.

## TV side

`web/src/lib/remote.ts`. Presses go through `injectPress()` in lib/input.ts, the same handler stack as a controller:
`down` starts OS-style repeats after 400 ms until `up` (10 s safety stop), so a held D-pad or a swipe-pad long press
(hold A = context menu) behaves like the real thing.

Typing sets the whole value of the focused input (the native setter + an `input` event, so Preact sees it). With no text
field focused, the TV switches to Search first. Enter sends a synthetic Enter keydown to the field (marked so
lib/input.ts lets it through). Passwords: the phone shows a password field and the TV never reports the value.

## Now playing

The player hands its live values and its OWN handlers to `components/RemotePlayer.ts`, which registers `nowPlaying` in
lib/remote.ts: a `state()` snapshot (title, episode, position/duration, paused, buffering, audio + subtitle lists with
the same labels as the TV's dialog, subtitle offset, audio boost, HDR picture, next episode, skippable segment, the
season's episodes) and an `act(op)` dispatcher. Every op calls the same function the TV's buttons and dialogs call, so
track memory, boost persistence, toasts, the picture stream restart and Next / episode switching behave exactly as with
a controller; nothing about playback lives in the remote layer.

The TV posts the state on discrete changes (pause, track, boost, seek...) plus every 5 s while playing; the phone
interpolates the position between reports. The season's episodes are fetched only while a phone is paired
(`remoteLive`). The HDR picture tile only exists when the TV shows its sun button (tone-mapped HDR + canEdit). Bazarr's
Find / Sync subtitles stay TV-only (admin tools with their own dialogs).

## Phone page

`web/remote.html` + `web/src/remote/` (separate Vite entry, ~10 KB of its own JS). The page never scrolls (fixed body,
`touch-action: none`, no zoom), so swipes only ever reach the pad. Swipe pad: one step per ~44 px of travel along the
dominant axis (a short flick of 22 px counts), tap = A, hold 480 ms = hold A. D-pad mode: press-and-hold buttons. The
keyboard sheet docks at the top so the iOS keyboard never covers it.

While the TV plays, a Now Playing button appears in the header's pad switch and opens the player panel in the pad's
slot (the pad / D-pad buttons bring the pad back, one tap): title, a scrubbable seek bar, back / play-pause / forward
(the TV's step), Skip Intro, Next episode, and tiles for Audio, Subtitles (list + timing ±0.5 s), Audio boost (tap
cycles the TV's steps), Night mode, Picture (HDR only) and Episodes. Pickers are bottom sheets whose lists scroll inside
themselves; the page itself still never scrolls (checked at 390x844 and 375x667).

## Lock screen

The phone can show what the TV plays on the iPhone lock screen / Control Center and pause it from there. iOS only gives
Now Playing to a page that is actually playing audio, so "Lock screen controls" (opt-in, one tap: iOS needs the
gesture) plays a looped 8 s silent WAV made in memory and hangs `navigator.mediaSession` off it: metadata (episode,
series, poster), `setPositionState()` from the TV's position, and play / pause / seek back / seek forward / seek to /
next track handlers that send the same `player` commands as the panel (`web/src/remote/lockscreen.ts`). The silent
element follows the TV's paused state, because on iOS the lock-screen play/pause icon comes from the element, not from
`mediaSession.playbackState`. When playback on the TV ends (12 s grace for Next episode), the audio stops and the
session is cleared. Off again = the toggle.

Poster: the phone has no Jellyfin token, so the TV only reports `{id, tag}`; the relay swaps that for
`api/remote/art/<random key>`, minted for that host's CURRENT item only (old keys die with the item), and fetches
`/Items/{id}/Images/Primary` server-side from `JELLYFIN_URL` (item images are anonymous in Jellyfin), max 600 px,
cached once per host. Works with the phone on the funnel URL and the TV on the LAN.

What iOS does and doesn't do (checked against WebKit source and reports; Safari and Home Screen web app):

- It interrupts the user's own music: a playing `<audio>` takes the audio session (that's what gets it Now Playing), so
  the toggle says so. `navigator.audioSession.type = 'playback'` is set where it exists (Safari 16.4+), not `ambient`,
  which would mix but never get Now Playing.
  [MDN AudioSession](https://developer.mozilla.org/en-US/docs/Web/API/AudioSession)
- Muted doesn't work: WebKit only makes an element the Now Playing session if it can produce audio, and `volume` is
  read-only (always 1) on iOS, so a muted or volume-0 element never shows. Hence real silent samples, not muting.
  [WebKit MediaElementSession `canShowControlsManager` / `isLongEnoughForMainContent`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/MediaElementSession.cpp),
  [Apple: volume is read-only on iOS](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html)
- Too short = UI sound: WebKit ignores audio of 0.95 s or less for Now Playing ("You've got mail" rule in the same
  file), hence 8 s, looped so it never ends.
- Locked screen: the web content process keeps running while it plays audible media (WebKit takes a "media playback"
  process assertion), so the watch long poll and the commands from lock-screen buttons keep working. Lock-screen
  buttons reach the page's action handlers as remote control commands that run with a user-gesture indicator
  (`MediaElementSession::didReceiveRemoteControlCommand` -> `MediaSession::callActionHandler`, gesture = yes), so the
  `play()` they trigger is allowed.
  [WebKit MediaSession.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.cpp),
  [WebKit WebProcessProxy (audible media assertion)](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebProcessProxy.cpp)
- Paused = may be suspended: the assertion is only held while the page is audible, so once our element is paused
  (because the TV paused) iOS is free to suspend the page and the lock screen keeps the last state. Lock-screen Play
  is still delivered (reported working for standalone web apps in WebKit bug 198277), so pause -> play from the lock
  screen should work; changes made on the TV while the phone sleeps paused show up when it wakes. A `play()` without a gesture (TV resumed while the phone page is hidden) can be refused: the page says
  "Tap Play here or on the lock screen" and the lock-screen Play fixes it.
- Home Screen web app: background audio in standalone mode was broken for years (stopped on lock,
  [WebKit bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277), fixed in iOS 15.4) and regressed again in
  iOS 26.0 betas ([r/PWA](https://www.reddit.com/r/PWA/comments/1l8hm1r/did_ios_26_break_background_audio_playback/),
  [MacRumors](https://forums.macrumors.com/threads/ios-26-audio-issues-in-pwa-web-apps-not-fixed-in-26-1-or-26-2-but-much-better.2466839/)).
  If the controls vanish on lock in the Home Screen app, use the page in Safari.
- Seek bar on the lock screen: iOS extrapolates from position + rate; the page refreshes it on every TV report and
  every 15 s, and when the element loops (iOS resets the position to the element's own clock on a loop/seek).
- Tested in Chromium (playwright: metadata, position, handlers, lock-screen pause/play/seek -> TV) and against the WebKit
  source above; not yet on a physical iPhone. Android Chrome uses the same Media Session API and should show the same
  media notification.

## Config

`JELLYSHELL_REMOTE=0` turns the page and relay off (docs/configuration.md). The Settings row is hidden in bundled mode
(no page server).
