# JellyShell Dash — requirements (v0, 2026-10-13)

Apple-TV-style home dashboard. One web app served from your home server; runs in a desktop browser
now, later inside the JellyShell UWP/WebView2 shell on the Xbox (same focus engine + input).

## Hard constraints
- Calendar + Apple Home go **through the Mac**.
  Work calendar must NOT be configured on the server. The Mac pushes snapshots; the server never
  holds Google/iCloud creds.
- UI language = JellyShell (theme tokens, Inter, glass tab bar, white focus fill, Ken Burns).

## Tabs
1. **Overview** — clock/date, now + today's weather, next meetings, home quick-scenes, server
   mini-stats, photo backdrop.
2. **Calendar** — today + next 7 days agenda, all calendars (colors from Calendar.app).
3. **Weather** — now, hourly 24h chart, 7-day, sunrise/sunset, UV, AQI, rain next hour.
4. **Home** — rooms → accessories (lights, sensors), scenes. Read first; control (scene trigger,
   on/off) in phase 2 via command queue the Mac agent polls.
5. **Photos** — Immich: "on this day" memories, favorites, random; full-screen viewer.
6. **Server** — load/CPU/RAM/temp/net graphs (1h history), every disk, Docker containers
   (state, CPU, RAM).

## Cross-cutting
- **Ambient mode** after idle (default 3 min): full-screen Immich slideshow + clock + weather +
  next meeting. Any button wakes.
- **Meeting alert**: banner 5 min before an event with a meeting URL, QR code for the link.
- Stale-data honesty: every Mac-sourced tile shows "updated X min ago" when old.
- Works with mouse/keyboard in a browser and gamepad on Xbox.

## Out of scope (declined)
Public transport, Jellyfin/Seerr tiles (separate app), Apple Reminders, news.

## Architecture
- `server/server.py` — stdlib Python, binds DASH_BIND:DASH_PORT (default 0.0.0.0:8098). Proxies Open-Meteo (cached),
  Immich (API key server-side), samples /proc + /sys + cgroups every 5 s into ring buffers.
  `/api/push/{calendar,home}` accepts snapshots from the Mac (bearer token DASH_PUSH_TOKEN, see
  docs/configuration.md). Until the Mac pushes, endpoints return clearly-flagged mock data.
- `web/` — Vite + Preact + signals; `lib/focus.ts`, `lib/input.ts` copied from JellyShell.
- Mac agent (later): launchd LaunchAgent in the GUI session (TCC prompts work there, not over
  SSH) running `ical` + `homeclaw-cli`, POSTing JSON every 60 s.
