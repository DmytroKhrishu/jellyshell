# Configuration

Every server-side setting is an environment variable. `web-poc/server.py`, `dash/server/server.py`, the
now-playing sidecar and `tools/*.py` also read an optional **`.env` file at the repo root** (copy
[`.env.example`](../.env.example)); a variable that is already set in the environment (systemd `Environment=`,
`docker run -e`, shell `export`) always wins over `.env`. `.env` is gitignored: keep secrets there or in a file
outside the repo, never in tracked files.

The `.env` parser is deliberately simple: `KEY=VALUE` per line, `#` comments, an optional `export ` prefix,
optional matching single/double quotes. No variable expansion. `JELLYSHELL_ENV_FILE=/path/to/file` points all
three programs at a different file.

Empty means "unset" everywhere.

Using a different service than the ones below (another download client, smart-home hub, photo library, calendar)?
See [integrations.md](integrations.md).

## Page server (`web-poc/server.py`)

| Variable | Default | What it does |
|---|---|---|
| `JELLYSHELL_BIND` | `0.0.0.0` | LAN listener address (what TVs/consoles/browsers load). |
| `JELLYSHELL_PORT` | `8097` | LAN listener port. |
| `JELLYSHELL_PUBLIC_PORT` | `0` (off) | Optional hardened listener for a reverse proxy / Tailscale Funnel / Cloudflare Tunnel (deny-by-default handler, rate limits, security headers, no debug hooks). See [public-access.md](public-access.md). |
| `JELLYSHELL_PUBLIC_BIND` | `127.0.0.1` (Docker: `0.0.0.0`) | Address of the public listener. Bare metal: use `0.0.0.0` only when the proxy runs on another host. In Docker the published port (`127.0.0.1:8093:8093`) limits access instead. |
| `JELLYSHELL_PUBLIC_PREFIX` | `/jellyshell` | Sub-path the proxy serves the UI under. Both prefix-stripping and pass-through proxies work. `''` = served at `/`. |
| `JELLYSHELL_DEBUG` | `0` | `1` enables the LAN-only debug hooks: the remote-control queue (`POST /api/cmd`, used by `tools/ui.py` / `tools/drive.py`) and `POST /snap`. Off by default; never available on the public listener. |
| `JELLYSHELL_HOST_PORT`, `DASH_HOST_PORT` | `8097`, `8098` | docker compose only: the host ports the LAN listeners are published on. To move a service, change these, not `JELLYSHELL_PORT` / `DASH_PORT` (the ports inside the container). |
| `JELLYSHELL_DATA_DIR` | `web-poc/` (Docker: `/data`) | Runtime files: `client.log`, `subs_created.json`, `snaps/`, `apk/` (Android APKs served at `/tv.apk`, `/android.apk`). |
| `JELLYSHELL_LOG_FILE` | `$JELLYSHELL_DATA_DIR/client.log` | Client log lines (`POST /log`), with the Jellyfin API key scrubbed. |
| `JELLYSHELL_TZ`, `TZ` | host zone, else `UTC` | Household clock (IANA name, e.g. `America/New_York`) returned as `timeZone` in `GET /api/config`; the UI uses it for "ends at" times when Settings → Time zone is Auto. |
| `JELLYSHELL_DIST` | `web/dist` | Built UI to serve (rarely needed). |
| `STORE_PRODUCT_ID` | — | Microsoft Store product id. When set, `/install` is a link page for the Xbox browser; otherwise `/install` doesn't exist. |
| `STORE_PRIVATE` | `0` | `1` for a Private-audience listing: the web fallback link becomes `apps.microsoft.com/detail/restricted/<id>` (the plain URL 404s for private apps). |
| `PRIVACY_CONTACT` | — | Email shown on `/privacy`. Unset: "contact the administrator of this server". |

### Jellyfin

| Variable | Default | What it does |
|---|---|---|
| `JELLYFIN_URL` | `http://127.0.0.1:8096` (Docker: `http://host.docker.internal:8096`) | How the server reaches Jellyfin (token checks, item lookups). |
| `JELLYFIN_PUBLIC_URL` | — | The Jellyfin address clients should log in to, e.g. `http://<server-lan-ip>:8096` or `https://jellyfin.example.com`. Returned as `jellyfinUrl` in `GET /api/config`; the web UI uses it as the default server on the login screen. |
| `JELLYFIN_API_KEY` | — | Admin API key (Jellyfin Dashboard → API Keys). Needed for subtitle tools, HDR picture controls and key scrubbing in client logs. Never sent to clients. |
| `JELLYFIN_API_KEY_FILE` | — | Alternative to the above: a file (e.g. a Docker secret) holding the raw key or JSON `{"key": "..."}`. |

### Optional integrations

Each integration is **off until both its URL and its key are set**. Off means: its routes answer
`503 {"error": "<service> not configured"}` and the per-user `capabilities` in `GET /api/config` hide the feature.

| Variables | Feature | Capability flag (UI effect) |
|---|---|---|
| `SEERR_URL`, `SEERR_API_KEY` | Requests (Seerr / Jellyseerr / Overseerr): Requests tab, Request buttons, person/TMDB pages | `seerr` (tab hidden), `requests` (buttons hidden) |
| `SONARR_URL`, `SONARR_API_KEY` and/or `RADARR_URL`, `RADARR_API_KEY` | Downloads tab + release calendar (Jellyfin admins only) | `downloads` |
| `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD` | Live speed / ETA in Downloads (needs Sonarr or Radarr) | — |
| `BAZARR_URL`, `BAZARR_API_KEY` **and** `JELLYFIN_API_KEY` | Subtitle tools: find / download / sync / delete (admins or users with subtitle management) | `subtitleTools` |
| `JELLYFIN_API_KEY` | HDR → SDR picture controls (brightness/contrast, admins edit) | `picture` (`GET /api/picture` 503 → row and player button stay hidden) |

URLs are the apps' base URLs (`http://seerr:5055`, not `.../api/v1`; an `/api/...` suffix is stripped).

| Variable | Default | What it does |
|---|---|---|
| `ARR_CONFIG_DIR` | — | Convenience: a directory with the apps' config dirs. Missing keys are read from `<dir>/seerr/config/settings.json`, `<dir>/sonarr/config/config.xml`, `<dir>/radarr/config/config.xml`, `<dir>/bazarr/config/config/config.yaml`, and qBittorrent credentials from Sonarr's database (`<dir>/sonarr/config/sonarr.db`, opened read-only). Works on a read-only mount. Explicit variables win. |
| `ARR_HOST` | `127.0.0.1` (Docker: `host.docker.internal`) | With `ARR_CONFIG_DIR`, apps whose URL isn't set default to `http://$ARR_HOST:<default port>` (Seerr 5055, Sonarr 8989, Radarr 7878, Bazarr 6767, qBittorrent 8081). |
| `MEDIA_PATH_MAP` | `/media=/media` | Subtitle backups (`*.jellyshell-bak`) and cut checks open the subtitle files Bazarr reports. Map Bazarr's path prefix to a path this server can read/write: `'<their-prefix>=<local-path>'`, several separated by `;`. Unmapped paths simply skip backups. |

### `GET /api/config`

```json
{ "timeZone": "Europe/Berlin", "serverTimeMs": 1790000000000,
  "jellyfinUrl": "https://jellyfin.example.com",
  "capabilities": { "public": false, "seerr": true, "requests": true, "downloads": true, "subtitleTools": false, "picture": true } }
```

`jellyfinUrl` only when `JELLYFIN_PUBLIC_URL` is set; `capabilities` only with a valid `X-Jellyfin-Token`
(+ `X-Jellyfin-User`) header. Older clients ignore unknown flags; a missing flag means "allowed".

## Dashboard (`dash/server/server.py`)

| Variable | Default | What it does |
|---|---|---|
| `DASH_BIND`, `DASH_PORT` | `0.0.0.0`, `8098` | Listener. |
| `DASH_DATA_DIR` | `dash/server/state/` (Docker: `/data`) | Pushed snapshots, settings, cached backdrops. |
| `DASH_LOG_FILE` | `$DASH_DATA_DIR/client.log` | Client log lines. |
| `DASH_LAT`, `DASH_LON` | — | Weather location (Open-Meteo, no key). Unset: `/api/weather` → `503 {"configured": false}`, the Weather page says so, Overview hides the tile content. |
| `DASH_PLACE` | weather zone's city | Place name shown next to the weather. |
| `IMMICH_URL`, `IMMICH_API_KEY` | — | Photos (memories, favorites, ambient slideshow). Unset: photos off (`503 {"configured": false}`). |
| `DASH_PUSH_TOKEN` | — | Bearer token for the Mac agent (`dash/mac-agent`) pushing Calendar + Home snapshots. Unset: push/command endpoints answer 503 and Calendar/Home show clearly flagged sample data. |
| `DASH_DISKS` | `System=/` | Server tab disks: `Label=/path;Label2=/path2`. |
| `DASH_NET_IF` | auto | Network interface for the traffic graph (default: busiest non-loopback, non-container interface). |
| `DASH_HOSTNAME` | system hostname | Name shown on the Server tab. |
| `DASH_TZ` | `JELLYSHELL_TZ` / `TZ` / host zone | Dash clock. A bare UTC default isn't reported, so the UI falls back to the weather location's zone. |
| `DASH_BACKDROPS` | `150` | Featured landscape photos cached from Wikimedia Commons (`0` = off). |
| `DASH_CONFIG_FILE` | — | Optional legacy JSON (`{lat, lon, place, immich_url, immich_key, push_token}`); env vars win. |
| `DASH_DEBUG` | `0` | `1` accepts `POST /api/cmd` (remote debug key queue). |
| `NP_URL` | `http://127.0.0.1:8102` (Docker: `http://nowplaying:8102`) | Where the dash finds the now-playing sidecar. |

`GET /api/config` on the dash returns `{timeZone?, serverTimeMs, configured: {weather, photos, push, nowplaying, calendar, home}}`.

### Now-playing sidecar (`dash/server/nowplaying.py`, optional)

Needs `pyatv` + `aiohttp` ([`dash/server/requirements-nowplaying.txt`](../dash/server/requirements-nowplaying.txt)).

| Variable | Default | What it does |
|---|---|---|
| `NP_DEVICE_ID` | — (required) | HomePod / Apple TV identifier from `atvremote scan`. Unset: the sidecar exits with a message, the dash shows "Now playing isn't set up". |
| `NP_DEVICE_NAME` | the name the device announces | Label in the dash. |
| `NP_HOST` | — | Optional IP hint for a fast first connect (falls back to a multicast scan). |
| `NP_BIND`, `NP_PORT` | `127.0.0.1`, `8102` (Docker: `0.0.0.0`) | Sidecar listener. |

## Dev tools (`tools/`)

| Variable | Used by | What it does |
|---|---|---|
| `XBOX_HOST` / `XBOX_PORTAL_URL` | `deploy.py`, `drive.py`, `ui.py shot` | Xbox Dev Mode Device Portal (`https://$XBOX_HOST:11443`). |
| `XBOX_PORTAL_CRED_FILE` | same | File with `user:pass` for the Device Portal (default `~/.config/xbox-devportal.cred`). |
| `XBOX_PACKAGE_MATCH` | `drive.py launch` | Package full-name substring (default `.JellyShell_`). |
| `GITHUB_REPOSITORY` | `deploy.py` | `owner/repo` with the CI artifacts (default: `gh repo view` of this checkout; `--repo` overrides). |
| `JELLYSHELL_URL` | `ui.py`, `drive.py` | The page server to send debug commands to (default `http://127.0.0.1:8097`; needs `JELLYSHELL_DEBUG=1` there). |
| `JELLYFIN_URL`, `JELLYFIN_CLIENT_URL` | `drive.py jf`, `cert-account.py` | Jellyfin from this machine / from the console (stream URLs). |
| `JELLYFIN_API_KEY` (`_FILE`), `JELLYFIN_USER_ID` | `ui.py auth`, `drive.py jf`, `cert-account.py` | Testing-only sign-in / admin calls. |
| `JELLYFIN_PUBLIC_URL`, `CERT_ACCOUNT_NAME` | `cert-account.py` | Server URL written into the tester's credential file; account name (default `cert-tester`). |
| `CDP_PORT` | `android-cdp.mjs` | Forwarded WebView DevTools port (default 9333). |

## Web UI dev server (`web/`, `dash/web/`)

`npm run dev` listens on `localhost` by default. `VITE_HOST=0.0.0.0` exposes it to a TV/console, `VITE_PORT`
changes the port. `JELLYSHELL_DEV_API=http://127.0.0.1:8097` (web) / `DASH_DEV_API` (dash, default
`http://127.0.0.1:8098`) proxy the server routes so `api/config`, Requests etc. work in dev.
