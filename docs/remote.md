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
`{key:'enter'|'clear'}`, `{playpause:true}`.

## TV side

`web/src/lib/remote.ts`. Presses go through `injectPress()` in lib/input.ts, the same handler stack as a controller:
`down` starts OS-style repeats after 400 ms until `up` (10 s safety stop), so a held D-pad or a swipe-pad long press
(hold A = context menu) behaves like the real thing.

Typing sets the whole value of the focused input (the native setter + an `input` event, so Preact sees it). With no text
field focused, the TV switches to Search first. Enter sends a synthetic Enter keydown to the field (marked so
lib/input.ts lets it through). Passwords: the phone shows a password field and the TV never reports the value.

The player sets `nowPlaying` (title, episode, paused, toggle) for the phone's play/pause button.

## Phone page

`web/remote.html` + `web/src/remote/` (separate Vite entry, ~10 KB of its own JS). The page never scrolls (fixed body,
`touch-action: none`, no zoom), so swipes only ever reach the pad. Swipe pad: one step per ~44 px of travel along the
dominant axis (a short flick of 22 px counts), tap = A, hold 480 ms = hold A. D-pad mode: press-and-hold buttons. The
keyboard sheet docks at the top so the iOS keyboard never covers it.

## Config

`JELLYSHELL_REMOTE=0` turns the page and relay off (docs/configuration.md). The Settings row is hidden in bundled mode
(no page server).
