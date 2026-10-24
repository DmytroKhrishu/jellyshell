# Swapping integrations

JellyShell and its dashboard talk to a handful of services: Seerr, Sonarr/Radarr, qBittorrent, Bazarr on the media side,
and Open-Meteo, Immich, a Mac agent (Calendar + Apple Home) and a HomePod sidecar on the Dash side. They are what the
author runs. If you run something else (Transmission instead of qBittorrent, Home Assistant instead of Apple Home,
Google Calendar, PhotoPrism, Sonos, ...), this page shows where each one is wired in and how to replace it.

Every integration follows the same pattern, so a swap is usually one function on the server:

1. **The UI never talks to a third-party service.** It calls the JellyShell page server (`web-poc/`) or the Dash
   server (`dash/server/`), which hold the keys and translate.
2. **Each feature has one JSON shape** (listed below). Keep the shape, change where the data comes from, and the UI
   doesn't need to change.
3. **Every integration can be off.** Unset = the route answers `503 {"error": "... not configured"}` (or
   `{"configured": false}` on the Dash) and the UI hides the feature. A feature you don't want needs no code change: leave its
   variables empty ([configuration.md](configuration.md)).
4. **Push beats pull for things on other machines.** Calendar and Home are pushed to the Dash with a bearer token, so
   any script, on any OS, in any language, can feed them.

## For AI coding agents

If someone asks you to "make the Dash use X instead of Y": find Y's row below, open the listed server function, and
reimplement it against X so it returns exactly the documented shape (field names, units, types). Add X's settings as env
variables in that program's config module (`web-poc/config.py` or `dash/server/dashconfig.py`), with an "is configured"
check that makes the route return the existing not-configured answer, and document them in `.env.example` and
`docs/configuration.md`. Don't touch the web UI unless X can't supply a field. Then mark the field optional in the UI,
because the original provider still has to work. Keep the server programs stdlib-only Python (a provider that needs a
pip package gets its own sidecar, like `dash/server/nowplaying.py`). Verify with `curl` against the route and in the
browser UI, with the provider both configured and unset.

## Media side (`web-poc/`)

| Feature | Provider today | Server code | Routes the UI uses |
|---|---|---|---|
| Requests | Seerr / Jellyseerr / Overseerr | `arr_proxy.py` (`seerr`, `seerr_get`, `create_request`, `my_requests`, `release_dates`, `request_options`) | `GET /api/seerr/*` (allow-listed pass-through), `POST /api/seerr/request`, `GET /api/seerr/dates`, `GET /api/seerr/reqoptions` |
| Downloads queue | Sonarr + Radarr, speeds from qBittorrent | `arr_proxy.py` `downloads`, `_qb_get`, `recent_imports` | `GET /api/downloads` |
| Release calendar | Sonarr + Radarr | `arr_proxy.py` `calendar` | `GET /api/calendar?start=&end=` |
| Subtitle tools | Bazarr (+ Jellyfin admin key) | `subs_proxy.py` | `/api/subs/*` |
| HDR picture | Jellyfin encoding settings | `picture_proxy.py` | `GET/POST /api/picture` |

**Download client (the easiest swap).** `downloads()` takes the queue from Sonarr/Radarr and only uses the torrent
client for live progress, speed and ETA, matched by the *arr `downloadId` (the torrent hash). To use Transmission, Deluge,
SABnzbd or NZBGet, replace `_qb_get('/api/v2/torrents/info')` with a call that returns, per download id:
`progress` (0..1), `dlspeed` (bytes/s), `eta` (s), `size`, `amount_left`, `state`. Without any client the queue still
works, just without live speed. Response shape:

```json
{ "items": [{ "id": "sonarr:<downloadId>", "kind": "episode|movie", "title": "", "subtitle": "S01E02 · Title",
              "poster": "url", "tmdbId": 0, "seasonNumber": 1,
              "status": "downloading|stalled|importing|queued|failed", "percent": 42.5,
              "size": 0, "sizeLeft": 0, "speed": 0, "eta": 0, "quality": "WEBDL-1080p", "message": "" }],
  "recent": [ ... same item shape, last imports ... ], "errors": ["qbittorrent: ..."], "at": 1790000000 }
```

**Requests.** The UI uses Seerr's own API paths and objects (discover, search, media details, request bodies) through
an allow-list. A different request tool (Ombi, ...) means writing a translation layer that answers those same paths in
Seerr's format. That is a large job: copy the paths the UI calls from `web/src/lib/seerr.ts`.

**Subtitles.** `subs_proxy.py` is Bazarr-specific: it maps Jellyfin items to Sonarr/Radarr ids and drives Bazarr's
search, download and sync jobs. Another subtitle backend would replace `search`, `download`, `sync` and `delete`, keeping
their JSON (see the functions' return values). If you don't use Bazarr, leave it unset and the subtitle tools disappear.

## Dashboard (`dash/server/server.py`)

| Tile / page | Provider today | Server code | Route |
|---|---|---|---|
| Weather | Open-Meteo (no key) | `weather()` | `GET /api/weather` |
| Photos, memories, ambient slideshow | Immich | `photos()`, `immich_image()` | `GET /api/photos`, `GET /api/photo/<id>?size=thumbnail\|preview` |
| Calendar | pushed (author: macOS agent reading EventKit) | `load_push('calendar')` | `POST /api/push/calendar` in, `GET /api/calendar` out |
| Home (lights, sensors, scenes) | pushed (author: macOS agent + HomeClaw for Apple Home) | `normalize_home()`, `HOME_QUEUE` | `POST /api/push/home` in, `GET /api/home` out, commands via `GET /api/home/commands` |
| Now playing | HomePod / Apple TV via the pyatv sidecar | `nowplaying()`, `np_cmd()` → `dash/server/nowplaying.py` | `GET /api/nowplaying`, `POST /api/nowplaying/cmd` |
| Server stats | the host itself (`/proc`, Docker socket) | `Metrics` | `GET /api/server` |
| Backdrops | Wikimedia Commons featured landscapes | `sync_backdrops()` | `GET /api/backdrops` |

**Calendar (any source, no code change).** Anything that can POST JSON can feed it: a cron job reading an ICS/CalDAV
feed, a Google Calendar script, a phone shortcut. Set `DASH_PUSH_TOKEN` and push the next ~8 days every minute or so:

```sh
curl -X POST http://<dash-host>:8098/api/push/calendar \
  -H "Authorization: Bearer $DASH_PUSH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"events":[{"title":"Dentist","start":"2026-11-02T09:30:00+01:00","end":"2026-11-02T10:15:00+01:00",
                  "calendar":"Home","color":"#63DA38","allDay":false,
                  "location":"optional","url":"optional meeting link"}]}'
```

`start`/`end` are ISO 8601 with an offset. All-day events are local midnight to midnight with `"allDay": true`. A
newer push replaces the whole list.

**Home (Home Assistant, openHAB, Homey, ...).** The push endpoint runs `normalize_home()`, which currently expects
HomeClaw's `list --json` / `scenes --json` output. Either send that format, or (cleaner) change `normalize_home()` to
accept already-normalized data. The UI wants:

```json
{ "home": "Home", "scenes": [{ "id": "...", "name": "Movie Time" }],
  "rooms": [{ "name": "Living Room", "accessories": [
      { "id": "...", "name": "Ceiling", "type": "light", "on": true, "brightness": 70, "reachable": true },
      { "id": "...", "name": "Kettle", "type": "outlet", "on": false },
      { "id": "...", "name": "Temperature", "type": "sensor", "value": 22.4, "unit": "°C", "battery": 80 },
      { "id": "...", "name": "Door", "type": "sensor", "kind": "contact", "value": "Closed", "unit": "" } ] }] }
```

Taps in the UI are queued as commands for your agent to run. The agent polls `GET /api/home/commands` (same bearer
token) and gets `[{"op": "trigger", "scene": "<id>"}, {"op": "set", "id": "<id>", "characteristic": "power|brightness",
"value": ...}]`. A Home Assistant agent maps those to `scene.turn_on` / `light.turn_on` service calls, then pushes fresh
state. `dash/mac-agent/main.swift` is the reference agent (about 170 lines).

**Weather.** The UI reads Open-Meteo's field names (`current.temperature_2m`, `current.weather_code` as WMO codes,
`hourly.*`, `daily.*`, `minutely_15.precipitation`, optional `air.european_aqi`). For another provider, make `weather()`
return the same structure and convert its condition codes to WMO (`dash/web/src/lib/wmo.ts` lists them).

**Photos (PhotoPrism, Nextcloud Memories, a folder, ...).** Reimplement `photos()` to return
`{memories: [{title, assets}], favorites: [asset], random: [asset]}` with `asset = {id, taken, place, w, h}`
(`taken` = local wall time `YYYY-MM-DDTHH:MM:SS`, no zone). Then make `immich_image(id, size)` return
`(bytes, content_type)` for `thumbnail` (small) and `preview` (screen-sized). The Immich-specific junk filter
(`junk_ids`, `is_photo`) can simply return "keep everything".

**Now playing (Spotify, Sonos, MPD, Plex, ...).** Write a small sidecar that serves the same three endpoints as
`dash/server/nowplaying.py`, and point `NP_URL` at it:

- `GET /state` (always 200): `{available, device, device_state: "playing|paused|idle|loading|seeking", title, artist,
  album, genre, position, total_time, sampled_at, volume, app, can: {play_pause, next, previous, volume_up,
  volume_down}, artwork_hash}`
- `GET /artwork`: image bytes, 404 when none
- `POST /cmd`: `{"action": "play_pause|next|previous|volume_up|volume_down"}`

**Server stats.** `Metrics` reads the host it runs on. In Docker that is the host for CPU, RAM, temperature and uptime,
but the container for the network card and hostname, unless you use `network_mode: host` ([docker.md](docker.md)). Disks
come from `DASH_DISKS`. Monitoring a different machine means replacing `Metrics.snapshot()` with data from that machine
(e.g. a Glances or Netdata API).
