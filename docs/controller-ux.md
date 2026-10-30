# Controller & Focus UX Spec — Jellyfin Xbox Shell

Status: draft v1 (research-backed, 2026-10-13). Target: Xbox Series S, UWP shell + WebView2 web UI (served from home server), native `MediaPlayer` playback.

Legend: **[MS]** = Microsoft official guidance · **[REF]** = observed in a shipping app (sourced) · **[DECISION]** = our opinionated choice · **[UNVERIFIED]** = plausible but not confirmed by a source; validate on device.

Source numbers `[n]` refer to §6.

---

## 0. Principles (the short version)

1. **Microsoft conventions first, media-app conventions second.** A=select, B=back, Y=search, View=nav pane, Menu=context/options, LB/RB=tab/section switch, LT/RT=page up/down in browse [1][2]. In the player, buttons are re-purposed for transport (as Plex, Kodi, CBC Gem do) [5][6][7].
2. **Nothing critical may live only on X/Y/bumpers/triggers/right stick.** The Xbox media remote has no X/Y, sticks, triggers or bumpers [2]. Every shortcut must also be reachable by D-pad + A/B (+ Menu/View).
3. **Mouse mode off, always.** Directional focus only [3][2].
4. **Exactly one visible focus at all times** outside full-screen video; never on hidden/offscreen elements; trapped inside open dialogs [2][9].
5. **B never exits the app unexpectedly**, and B never loops (open/close menu ping-pong). At the root, B may leave the app (Android TV guidance; no exit-confirmation gate) [10].

---

## (a) Button mapping per context

Gamepad rows map 1:1 to `Windows.System.VirtualKey` names (`GamepadA`=195 … `GamepadRightThumbstickLeft`=218) [4].

### a1. Browse (home rows / library grid)

| Input | Action | Basis |
|---|---|---|
| D-pad / Left stick | Move focus (spatial) | [MS] [2] |
| A | Open item (detail page); on a "Play"/"Resume" tile, play | [MS] [2] |
| B | Back. On a row scrolled away from start: first B scrolls row to start / returns focus to nav (only if that's the established pattern — see b4); at app root: exit to dashboard, no confirm | [MS] [2]; [REF] Android TV [10] |
| X | **Quick play / resume focused item** (skip detail page); on play tiles (Continue Watching / Next Up, A already plays) X = context menu | [REF] Plex "X – immediately play/resume the highlighted item" [5] |
| Y | **Search** | [MS] "Search — Y button — shortcut to the main search function" [2] |
| Menu (≡) | Context menu for focused item (Mark watched, Favorite, Go to series, Play from start, Shuffle) | [MS] Menu = open context menu [2] |
| View (⧉) | Open/close left nav pane (Home, Movies, Shows, Music, Search, Settings) | [MS] View = open/close nav pane [2] |
| LB / RB | Previous/next top-level section or library tab (pivot) | [MS] bumpers = page left/right in pivot/FlipView-style views [2] |
| LT / RT | Page up/down: jump focus one viewport of rows (rows view) or one screen of grid lines (grid view) | [MS] triggers = page up/down in lists/grids/ScrollViewer [2] |
| Right stick | Unused (reserve; optionally fast-scroll in long grids) | [DECISION] |
| L3 / R3 | Unused | [DECISION] (Kodi uses them for screenshot/shutdown — not appropriate here [6]) |

### a2. Detail page (movie / series / season / episode)

| Input | Action | Basis |
|---|---|---|
| D-pad | Move between action buttons (Play/Resume, Restart, Trailer, Audio/Subs, Favorite, Watched), seasons, episode row, cast, similar | [MS] |
| A | Activate focused button / open episode | [MS] |
| B | Back to previous screen, **restoring focus to the item that opened it** (b3) | [MS] [2] |
| X | Play/Resume (same as primary button, from anywhere on the page) | [DECISION], consistent with Plex X=play [5] |
| Y | Search | [MS] [2] |
| Menu | More options (same menu as browse context menu) | [MS] [2] |
| LB / RB | Previous/next season (series) or previous/next episode (episode page) | [DECISION] (bumpers = pivot switching [2]) |
| LT / RT | Page up/down the detail page | [MS] [2] |
| View | Nav pane | [MS] [2] |

Initial focus: primary action (Resume if progress > 0, else Play). [MS] "set initial focus" [2]; Apple "primary item" concept [11].

### a3. Player — full-screen video, overlay HIDDEN

Mainstream apps disagree on exact numbers; this is a deliberate blend of Apple TV (tap = ±10 s, hold = continuous scan) [12], Plex (D-pad up/down = ±10 min, LB/RB cycle FF/RW speeds) [5], Kodi (triggers/bumpers = analog rewind/FF; up/down = chapter-or-10-min) [6], CBC Gem (LT rewind / RT FF) [7].

| Input | Action | Basis |
|---|---|---|
| A | Play/Pause **and** show overlay briefly | [REF] Kodi A=Pause [6]; Plex A=show OSD [5] → [DECISION] combine |
| B | Show overlay if hidden; if overlay already visible → hide; second B within overlay-hidden state from a *paused, just-opened* state is NOT exit. Exit player = B while overlay visible with focus on transport **or** dedicated "Stop/Back" button. See b5 | [DECISION] to avoid accidental stop; Plex/Kodi map B=stop [5][6], which we deem too destructive |
| D-pad ← / → (tap) | Seek −10 s / +10 s (configurable; respects Jellyfin's skip-back/forward user settings), shows mini seek bar | [REF] Apple TV ±10 s [12]; Plex −10/+30 s [5]; jellyfin-web has `skipBackLength()` user setting [13] |
| D-pad ← / → (hold) | Scrub with acceleration (see §4) | [REF] Apple TV hold = continuous, 2×/3×/4× [12] |
| D-pad ↑ | Open overlay with focus on transport bar | [REF] Apple TV "press up on clickpad ring" shows controls [12] |
| D-pad ↓ | Open overlay with focus on bottom panel (Audio / Subtitles / Chapters / Episodes) | [DECISION] |
| LB / RB | Previous / next **chapter** (fallback: −/+ 10 min when no chapters) | [REF] Kodi `ChapterOrBigStepBack/Forward` [6]; Plex ±10 min on ↑/↓ [5] → [DECISION] put on bumpers |
| LT / RT | **Hold** = analog rewind/fast-forward scrubbing, speed proportional to trigger depth; release = commit position | [REF] Kodi AnalogRewind/AnalogFastForward on triggers [6]; CBC Gem LT/RT [7] |
| X | Audio & subtitle quick menu | [DECISION]; Kodi X=OSD [6] |
| Y | Toggle subtitles on/off (last-used track) | [DECISION]; Kodi left-thumb=ShowSubtitles [6] |
| Menu | **Picture in picture** (playback shrinks into a corner window, the app stays usable; Menu on any page = back to full screen). Shells without PiP: show/hide the overlay | [DECISION, changed 2026-10 on user request] mirrors Menu = full screen while browsing |
| View | Show media info (title, time-of-day, end time) | [DECISION] |
| Skip-intro/credits prompt visible | **A activates Skip** (prompt holds focus while shown) | [DECISION]; Plex advertises "skipping … in just two clicks" [14] |

Remote-control parity: the Xbox media remote has D-pad, A/Select, B/Back, Menu, View, OneGuide but no X/Y/LB/RB/LT/RT [2]; everything above is also reachable through the overlay with D-pad + A.

### a4. Player — overlay VISIBLE

| Input | Action |
|---|---|
| D-pad | Focus navigation within overlay (transport bar ↔ buttons ↔ bottom panel). When the **seek bar** has focus, ←/→ seek (with hold-acceleration) — use *focus engagement*: seek bar responds to ←/→ only while focused; ↑/↓ leave it [MS] [2] |
| A | Activate focused control (on seek bar: commit preview position & play) |
| B | Close overlay (and cancel any uncommitted scrub preview → return to original position, like Apple TV) [12]. Does **not** stop playback |
| LB/RB, LT/RT, X, Y, Menu | Same as a3 (shortcuts stay live) |
| Auto-hide | 5 s after last input while playing; never while paused or while a menu is open [DECISION] |

Exiting playback: "Back/Stop" button in the overlay top-left (A), or B while overlay is visible and nothing else is open → confirm-free stop and return to detail page with progress saved [DECISION]. Kodi uses hold-B (500 ms) for leaving fullscreen [6]; we adopt **hold B ≥ 600 ms = stop & exit from any player state** as a power shortcut [DECISION].

### a5. Dialogs / menus / pickers (context menu, audio/sub picker, confirmations)

| Input | Action | Basis |
|---|---|---|
| D-pad | Move within dialog only (focus trapped) | [MS]/XAG 113 [9] |
| A | Choose | [MS] |
| B | Close dialog, return focus to invoker | [MS]; Kodi B=Close in dialogs [6] |
| Menu | Close (toggle) if dialog was opened by Menu | [DECISION] |
| LT/RT | Page up/down in long lists | [MS] [2] |
| Others | Ignored (no leakage to underlying page) | [DECISION] |

Initial focus = current selection (e.g. current subtitle track) or first item; destructive confirms default to **Cancel** [DECISION]; Android TV recommends a Cancel button when only confirm/destructive actions are visible [10].

### a5b. Subtitle tools (Bazarr)

Player: X opens Audio & Subtitles. The Subtitles column ends with action rows: **Find subtitles…**, **Fix timing (sync to audio)** (only when an external subtitle is selected; runs Bazarr's ffsubsync on that file and reloads the cues), **Show earlier / Show later** (±0.5 s local offset, stored per item in localStorage; **Reset timing** clears it) and **Remove this download** (only for files JellyShell itself downloaded, tracked in `web-poc/subs_created.json`). Detail page: Audio & Subtitles → Find subtitles… opens the same panel.

Find subtitles panel (right side, modal):

| Input | Action |
|---|---|
| D-pad | Move through candidates (sorted by score; rows matching your file's source or release group are tinted green) |
| A | Download the candidate. If it would overwrite the current file for that language ("Replaces current"), the first A asks and the second A confirms |
| B | Cancel a running search / close (ignored while a download is running) |
| LB / RB | Switch language (Settings' default subtitle language plus English) |
| LT / RT | Page up / down |

After a download the panel closes, Jellyfin refreshes the item, the new track is selected, and playback resumes if it was playing. Mouse: click a row = A, click outside the panel = B.

### a6. Search / on-screen keyboard

Use the **system** soft keyboard via a focused `<input>` where possible (it supports Xbox shortcuts and voice). If a custom in-page keyboard grid is built (Apple-TV-style letter row), map:

| Input | Action | Basis |
|---|---|---|
| D-pad | Move between keys / results | |
| A | Type key | Kodi VirtualKeyboard A=Select [6] |
| B | Backspace; when field empty → back | Kodi B=BackSpace [6] |
| X | Backspace (alternative), keeps B = back | [DECISION] |
| Y | Space / Symbols toggle | Kodi Y=Symbols [6] |
| LT / RT | Cursor left / right | Kodi lefttrigger=CursorLeft, righttrigger=CursorRight [6] |
| LB | Shift | Kodi leftbumper=Shift [6] |
| Menu / L3 | Submit / jump to results | Kodi leftthumb=Enter [6] |

Results update live (debounced ~300 ms) [DECISION]. jellyfin-xbox disables WebView2 autofill because it "puts down the virtual keyboard" on Xbox [15] — do the same.

---

## (b) Focus & navigation rules

1. **Initial focus** is always set programmatically on every screen (primary action / first card / previously-focused card). TVHelpers notes the library does *not* set initial focus; app must [16][2].
2. **One focus, always visible**, except full-screen video with overlay hidden [2]. Focus never lands on offscreen/invisible elements [9].
3. **Focus memory** — each row, grid and page remembers its last focused child (keyed by stable item id). Entering a row restores it; B from detail restores focus to the originating card and scroll position. (LRUD containers implement this via `data-focus` [17]; Apple "primary item" of focus groups [11].)
4. **Axes**: rows are vertical, items horizontal; ↑/↓ move between rows keeping the *column/x-position* closest to the previous one *or* the row's remembered item (we choose remembered item — Netflix-like; [UNVERIFIED] what Netflix actually does). Android TV: "categories on vertical axis, items within each category on horizontal axis" [10].
5. **Reachability**: any element reachable in ≤ 6 presses edge to edge; restructure layouts otherwise [1]. No controls in hard-to-reach corners [10].
6. **Wrap-around**: **no wrap** in rows/grids (hitting the end gives a subtle bump animation). Wrap allowed only in small closed menus (≤ 8 items) and the on-screen keyboard. TVHelpers shows wrap is an explicit override, not default [16]. [DECISION]
7. **Left edge → nav pane**: ← at first item of any row opens/focuses the nav rail [DECISION]; ↑ at top row focuses the top bar/tabs.
8. **Dialogs trap focus**; on close, focus returns to invoker [9].
9. **Engagement** for controls that consume D-pad (seek bar, sliders, horizontal pickers): A to engage, B to disengage, to avoid focus traps [2].
10. **Scroll follows focus**: focused card kept inside the TV-safe area with ≥ 1 card of look-ahead visible; rows scroll horizontally so focus stays at a fixed x-anchor (Apple TV-style "fixed focus" rows) [DECISION]; MS: keep focus visual and item inside TV-safe area even when lists extend to edges [1].
11. **Key repeat**: hold D-pad → repeat after 400 ms, then every ~80–120 ms, accelerating in long grids [DECISION, UNVERIFIED numbers]. Left stick: dead-zone ~0.5, treat as D-pad with same repeat; jellyfin-web's own gamepad shim uses threshold 0.75 [13].

### Focus visuals

| Rule | Basis |
|---|---|
| Focused card: scale 1.08–1.12, raised shadow, 3–4 px high-contrast outline (white/accent on dark) — **outline AND scale**, not scale alone (low-vision) | XAG 113 combined indicators [9]; Apple tvOS scale/elevation [11] |
| Supply artwork at focused size so scaling stays sharp; leave gutters so the scaled card doesn't overlap neighbours | Apple tvOS [11]; Android TV padding [10] |
| Text buttons: filled background swap (inverted colours) on focus | XAG 113 examples [9] |
| Parallax/tilt: optional, subtle, driven by D-pad direction only (no stick-driven tilt) and disabled when "reduce motion" is on | Apple uses parallax as its focus effect [11]; [DECISION] to keep it light for Series S perf |
| Pressed state: brief scale-down (~0.97) on A down | Apple "highlighted" state [11] |
| Animate with `transform`/`opacity` only (compositor-only), 120–180 ms ease-out | [DECISION, UNVERIFIED perf numbers] |

### Latency targets [DECISION — no authoritative source found]
- Input → focus visual change: ≤ 1 frame after JS handler (≤ 16 ms handler + 1 frame), target < 50 ms end-to-end.
- Input → player seek preview update: < 100 ms; actual seek commit on release.
- Never block the focus move on network (load images lazily; show placeholder).

---

## (c) Implementation notes — WebView2 on Xbox

### c1. Mouse mode
- XAML host: `Application.RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested` in the `App` constructor. Mouse mode is on by default on Xbox [3][2]. jellyfin-xbox does exactly this [18].
- `navigator.gamepadInputEmulation = "gamepad" | "keyboard" | "mouse"` is documented for **HTML/JS UWP (EdgeHTML / WWAHost)** apps [3]. **[UNVERIFIED] for WebView2** — do not rely on it; the XAML `RequiresPointerMode` on the host is what turns off the cursor.

### c2. How gamepad input reaches the page (pick ONE source of truth)
Observed facts:
- Gamepad API (`navigator.getGamepads()`) works inside UWP WebView2 **on real Xbox** (not on desktop without Gaming Services) — WebView2Feedback #4366 [19].
- jellyfin-web ships a shim that polls `navigator.getGamepads()` and synthesises `keydown`/`keyup` with `key: 'GamepadA'|'GamepadB'|'GamepadDPadUp'…` and `keyCode` 13/27/37–40 (A→Enter, B→Escape, D-pad→arrows), stick threshold 0.75 [13].
- In EdgeHTML WebView, gamepad buttons arrived as `keydown` with VirtualKey codes (e.g. B = `keyCode 196`), but only after the WebView actually had focus [20]. Whether WebView2 on Xbox also emits `GamepadX` keydown events is **[UNVERIFIED]** — log `event.key/keyCode` on device in sprint 0.
- WebView2 must be explicitly focused after `CoreWebView2Initialized` or it is unfocusable — jellyfin-xbox calls `WebView.Focus(FocusState.Programmatic)` there [15].

**[DECISION] Architecture:**
1. **Web UI** owns navigation input via a single `InputRouter` module: poll `navigator.getGamepads()` in `requestAnimationFrame` (edge-detect + repeat timer), *and* listen to `keydown` for keyboard/remote/any OS-synthesised gamepad keys; dedupe by ignoring `keydown` events whose `keyCode` is in 195–218 if the Gamepad API reported the same button in the last 50 ms. Emit semantic actions: `nav.up|down|left|right`, `select`, `back`, `search`, `menu`, `view`, `tabPrev|tabNext`, `pageUp|pageDown`, `quickPlay`, plus raw trigger values for analog scrub.
2. **Native player** (when native `MediaPlayer` is foreground, WebView hidden or overlay-only): native side reads `Windows.Gaming.Input.Gamepad.Gamepads[i].GetCurrentReading()` (or `CoreWindow.KeyDown` with `VirtualKey.Gamepad*` [4]) and either handles transport itself or forwards semantic actions to the overlay page via `CoreWebView2.PostWebMessageAsJson(...)`; page listens on `window.chrome.webview.addEventListener('message', …)` and replies with `window.chrome.webview.postMessage(...)`. Ensure only one layer handles a given press (ownership flag switched on player enter/exit).
3. Keyboard fallback mapping (PC testing & media remote): Arrows, Enter/Space=A, Escape/Backspace=B, `/` or F3=Y, PageUp/PageDown=LT/RT, `[`/`]`=LB/RB, ContextMenu key=Menu [DECISION]. MS: Arrow↔D-pad, Space/Enter↔A, Escape↔B are the built-in equivalences [2].

### c3. B / Back handling (critical)
- In UWP, if B's `KeyDown`/`KeyUp` isn't handled, `SystemNavigationManager.BackRequested` fires; the app must handle it or default behaviour applies [2]. Not handling it at the right level is how apps get suspended/"exited" on B.
- jellyfin-xbox registers prioritized `BackRequested` handlers and sets `args.Handled` [21] — copy that pattern: native `BackRequested` → `PostWebMessageAsJson({type:'back'})` → web router pops its own stack and replies `{handled:true|false}`; if `false` (at root) let the system take the app to the dashboard.
- Because the reply is async, set `args.Handled = true` immediately unless the web UI has previously reported `atRoot=true` (web pushes `atRoot` state on every route change) [DECISION].
- Do not render an on-screen back button when B goes back [2][10].

### c4. Safe area & scaling
- Xbox renders UWP apps at 1920×1080 regardless of TV; HTML apps default to 150 % scale (1280×720 CSS px), XAML 200 % (960×540 epx) [1]. **[UNVERIFIED]** what CSS viewport WebView2 gets inside a XAML host — read `innerWidth`/`devicePixelRatio` on device and design to a 1920×1080 or 1280×720 reference canvas with `rem` scaling.
- Extend the app to the full screen with `ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow)` [1] (jellyfin-xbox does this [18]); then keep **interactive/essential UI ≥ 5 % from edges** — 48 epx left/right, 27 epx top/bottom at 960×540 (= 96/54 px at 1080p, 64/36 px at 720p CSS) [1]. Backdrops/row overflow may bleed to the edge; focused item may not.
- Min interactive height 32 epx (64 px @1080p); main text ≥ 15 epx (30 px @1080p), secondary ≥ 12 epx (24 px) [1].
- Colours: Xbox auto-scales to TV-safe range since Fall Creators Update; avoid pure white large fields anyway [1].

### c5. Other WebView2 settings (from jellyfin-xbox, proven on Xbox) [15]
`AreDefaultContextMenusEnabled=false`, `AreDevToolsEnabled=false` (release), `IsStatusBarEnabled=false`, `IsZoomControlEnabled=false`, `IsGeneralAutofillEnabled=false`; handle `ContainsFullScreenElementChanged`; append `" WebView2 Xbox"` to UA if the server-side UI needs TV detection over plain HTTP.

### c6. Spatial navigation library — **recommendation: `@bbc/lrud-spatial`** (if UI is React, `@noriginmedia/norigin-spatial-navigation` is the alternative)

| | LRUD spatial (BBC) [17] | Norigin Spatial Navigation [22] | TVHelpers DirectionalNavigation (MS) [16] |
|---|---|---|---|
| Model | Pure function: `getNextFocus(currentFocus, keyOrKeyCode, scope)` → `HTMLElement`; uses real DOM focus | React-hooks (`useFocusable`) focus tree, virtual focus keys | Script that auto-handles arrow keys on DOM |
| Containers / focus memory | Yes: `nav`, `section`, `.lrud-container`, last focus via `data-focus` | Yes (focus boundaries, saved last child) [UNVERIFIED details] | Focus root only; manual overrides `data-tv-focus-*` |
| Block exits / boundaries | `data-block-exit="up down"` | yes | via overrides |
| Framework | Any (vanilla/Lit/Svelte/Vue/React) | React (RN variant exists) | Any; 2016-era, effectively unmaintained [UNVERIFIED] |
| Licence | Apache-2.0 [UNVERIFIED] | MIT [22] | MIT |

Why LRUD: framework-agnostic, tiny, operates on *real* `document.activeElement` (keeps ARIA/Narrator semantics, which XAG cares about [8]), has the exact primitives this spec needs (containers with memory, block-exit, overlap threshold, `lrud-ignore`), maintained by a broadcaster that ships it on TVs. We wrap it in `InputRouter` (c2) so the key source (Gamepad API vs keydown vs native postMessage) is irrelevant to it. Known gap: it ignores the Z axis — scope it to the top overlay/dialog element when one is open [17].

---

## (d) Xbox certification / UX MUSTs checklist

Hard requirements (policy/platform):
- [ ] Ship through Microsoft Store packaging; no general file-system/physical-media browsing on Xbox; do not request/store MSA credentials [23 §10.13.4, §10.2].
- [ ] If any part of the app "browses the web", it must use Chromium/Gecko (WebView2 = Chromium ✔) and must not let users download/copy arbitrary files on Xbox [23 §10.2]. Lock WebView2 navigation to the configured Jellyfin origin.
- [ ] Don't bind ports 57344–65535 (silently dropped on Xbox) [24].

Strongly-expected UX (MS design guidance; treat as MUST for us):
- [ ] Mouse mode disabled (`RequiresPointerMode=WhenRequested`) [3][2].
- [ ] All functionality reachable by gamepad **and** media remote (no critical action on X/Y/bumpers/triggers/sticks only) [2].
- [ ] B = back everywhere; `BackRequested` handled; no on-screen back button [2].
- [ ] Focus visible at all times (except full-screen video), never offscreen, initial focus set on every page, dialogs trap focus [2][9].
- [ ] Essential UI inside TV-safe area (48/27 epx) after `UseCoreWindow` [1].
- [ ] Min sizes: 32 epx targets, 15/12 epx text [1].
- [ ] Consistent navigation order and consistent button meanings across screens (XAG 112) [8].
- [ ] Media apps: integrate `SystemMediaTransportControls` so the Xbox guide/remote media keys work [UNVERIFIED as a cert requirement — best practice].

Note: the full Xbox **app** certification requirements (XR list for non-game media apps) are partner-gated; not verified here [UNVERIFIED].

---

## 4. Playback-specific best practices

- **Tap vs hold** on ←/→: tap = fixed jump (10 s), hold = continuous scrub with acceleration (Apple: 2×/3×/4× by repeated press) [12]. Our curve [DECISION]: hold 0–1 s → 10 s steps every 150 ms; 1–3 s → 30 s steps; > 3 s → 2 min steps; release = commit. Triggers give analog speed by depth (Kodi analog FF/RW) [6].
- **Preview before commit**: while scrubbing, video stays paused on last frame and the seek bar shows a **trickplay thumbnail** above the playhead; B cancels back to original position (Apple behaviour) [12]. Jellyfin server generates trickplay tile sheets (10.9+) [UNVERIFIED in this research — confirm API `/Videos/{id}/Trickplay/{width}/{index}.jpg`].
- **Skip Intro / Skip Credits**: show a focused pill button bottom-right while the segment is active, auto-focused so a single **A** skips; auto-dismiss at segment end; "Next episode" countdown card during credits with A = play next, B = dismiss [DECISION; Plex markets two-click skip [14]]. Source segments from Jellyfin Media Segments API [UNVERIFIED endpoint].
- **Audio/Subtitle quick menu**: one press (X) opens a two-column panel (Audio | Subtitles) with current tracks pre-focused; selecting applies instantly without closing; B closes [DECISION].
- **Long-press conventions**: A long-press (≥ 500 ms) on any item card = context menu, the Kodi convention (holdtime 500 ms) [6]. It's a second path only; Menu (≡) stays the primary, discoverable one. Tap A still activates on release. Mouse: right-click. Touch/pen: press-and-hold 500 ms (the following click is swallowed). Hold-B = exit player. Implementation: `web/src/lib/longpress.ts`. [DECISION, changed 2026-10 on user request]
- **Card context menu** (Menu / hold A / right-click / touch-hold, all cards incl. Continue Watching & Next Up): Resume|Play · Play from beginning · Go to episode / Open details · Go to series · Mark as watched/unwatched · Remove from Continue Watching (clears the saved position; Jellyfin 10.11 has no HideFromResume endpoint) · Add/Remove favorite. Focus starts on the first item; B closes. On play tiles (Continue Watching / Next Up, where A already plays) X opens this menu instead of duplicating A.
- **Overlay**: never auto-hide while paused or while a panel is open; show clock/end-time [DECISION].

---

## (e) Sources

1. Microsoft — Designing for Xbox and TV: https://learn.microsoft.com/en-us/windows/apps/design/devices/designing-for-tv
2. Microsoft — Gamepad and remote control interactions (button table, built-in mappings, accelerators: LT/RT page up/down, LB/RB page left/right, Y search, View nav pane, Menu context menu, focus engagement, BackRequested): https://learn.microsoft.com/en-us/windows/apps/design/input/gamepad-and-remote-interactions
3. Microsoft — How to disable mouse mode (`navigator.gamepadInputEmulation`, `RequiresPointerMode`): https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/how-to-disable-mouse-mode
4. Microsoft — `Windows.System.VirtualKey` enum (GamepadA=195…): https://learn.microsoft.com/en-us/uwp/api/windows.system.virtualkey
5. Plex Support — Xbox One Controller Mapping: https://support.plex.tv/articles/206940077-xbox-one-controller-mapping/
6. Kodi — default joystick keymap (`system/keymaps/joystick.xml`) and action reference: https://github.com/xbmc/xbmc/blob/master/system/keymaps/joystick.xml ; action list mirror: https://gist.github.com/CN-CODEGOD/cef0ee7e3542ffb30770bdbe7524a20c
7. CBC Gem — Using the Xbox Controller (LT rewind / RT fast-forward): https://cbchelp.cbc.ca/hc/en-ca/articles/13682804118299-Using-the-Xbox-Controller-with-the-CBC-Gem-App (search-snippet only)
8. Xbox Accessibility Guideline 112 — UI navigation: https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/112
9. Xbox Accessibility Guideline 113 — UI focus handling: https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/113
10. Android Developers — TV navigation (back behaviour, no exit gating, axes, cancel button): https://developer.android.com/training/tv/get-started/navigation
11. Apple HIG — Focus and selection (tvOS focus states, scale, parallax, no pointer): https://developer.apple.com/design/human-interface-guidelines/focus-and-selection
12. Apple Support — Control playback on Apple TV (±10 s, hold = 2×/3×/4×, scrub & cancel with Back): https://support.apple.com/guide/tv/control-playback-atvb120650e1/tvos
13. jellyfin-web — gamepad-to-key shim (`GamepadA` keys, threshold 0.75) & playbackmanager `skipBackLength`: https://github.com/jellyfin/jellyfin-web (src/scripts/gamepadtokey.js, playbackmanager)
14. Plex — skip intro/credits marketing ("in just two clicks"): https://www.plex.tv/
15. jellyfin-xbox — `JellyfinWebViewModel.cs` (WebView2 focus after init, settings, autofill off): https://raw.githubusercontent.com/jellyfin/jellyfin-xbox/master/Jellyfin/ViewModels/JellyfinWebViewModel.cs
16. Microsoft TVHelpers — Using DirectionalNavigation (initial focus, overrides, wrap): https://github.com/Microsoft/TVHelpers/wiki/Using-DirectionalNavigation
17. BBC LRUD spatial: https://github.com/bbc/lrud-spatial
18. jellyfin-xbox — `App.xaml.cs` (`RequiresPointerMode=WhenRequested`, `SetDesiredBoundsMode(UseCoreWindow)`): https://github.com/jellyfin/jellyfin-xbox
19. WebView2Feedback #4366 — Xbox controller in UWP WebView2 (works on Xbox, not desktop): https://github.com/MicrosoftEdge/WebView2Feedback/issues/4366
20. Microsoft Q&A — Xbox UWP WebView keydown not triggered on launch (keyCode 196 = B): https://learn.microsoft.com/en-us/answers/questions/1351127/xbox-uwp-webview-keydown-event-is-not-getting-trig
21. jellyfin-xbox — `GamepadManager.cs` (prioritized `BackRequested` handlers): https://raw.githubusercontent.com/jellyfin/jellyfin-xbox/master/Jellyfin/Core/GamepadManager.cs
22. Norigin Spatial Navigation: https://github.com/NoriginMedia/Norigin-Spatial-Navigation
23. Microsoft Store Policies (§10.2 browsers, §10.13 Gaming and Xbox): https://learn.microsoft.com/en-us/windows/apps/publish/store-policies
24. Microsoft — Known issues with UWP on Xbox (blocked ports): https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/known-issues
25. Microsoft Edge blog — WebView2 available for Xbox apps (STARZ uses it for full UI): https://blogs.windows.com/msedgedev/2023/11/01/webview2-for-xbox-announcement/

### Not sourced (deliberately no mappings given)
Netflix, YouTube, Disney+ and the Apple TV *app on Xbox*: no official or reliable controller-mapping documentation found. A Reddit thread notes YouTube-on-Xbox X/Y keyboard shortcuts (backspace/space) were removed at some point (https://www.reddit.com/r/youtube/comments/uo5x5h/) — anecdotal only. Validate by hands-on testing on the console before copying any of their conventions.
