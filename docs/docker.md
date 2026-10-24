# Running the JellyShell server with Docker

The repo ships one multi-stage [`Dockerfile`](../Dockerfile) and a [`docker-compose.yml`](../docker-compose.yml).

| Target / service | Port | What | Dependencies |
|---|---|---|---|
| `jellyshell` (default) | 8097 | Page server: the built web UI (`web/dist`) + Seerr / Sonarr / Radarr / qBittorrent / Bazarr proxies + client log | Python stdlib only |
| `dash` (profile `dash`) | 8098 | TV dashboard backend + UI (weather, photos, calendar/Home via the Mac agent, server stats) | Python stdlib only |
| `nowplaying` (profile `dash`) | 8102 | HomePod / Apple TV now-playing sidecar for the dash | `pyatv`, `aiohttp` |

All images run as a non-root user (uid 10001) and keep runtime files in the `/data` volume. Configuration is
environment variables only, see [configuration.md](configuration.md).

## Quick start

```sh
cp .env.example .env
# edit .env: at minimum nothing — Jellyfin on the Docker host at :8096 is the default.
# Optional: JELLYFIN_PUBLIC_URL, JELLYFIN_API_KEY, SEERR_*, SONARR_*, RADARR_*, BAZARR_* ...
docker compose up -d --build
curl -s http://localhost:8097/api/config
```

Other host ports: set `JELLYSHELL_HOST_PORT=` / `DASH_HOST_PORT=` in `.env` (leave `JELLYSHELL_PORT` / `DASH_PORT`
alone: those are the ports inside the container).

Then point a browser, the Xbox app ("JellyShell server" in setup/Settings) or the Android app at
`http://<server-ip>:8097`.

With the dashboard:

```sh
docker compose --profile dash up -d --build
# without a HomePod/Apple TV, skip the sidecar:
docker compose --profile dash up -d --build --scale nowplaying=0
```

## Reaching Jellyfin and the *arr apps

Pick one:

- **Apps published on the Docker host** (default). The compose file adds
  `extra_hosts: host.docker.internal:host-gateway`, and inside the image `JELLYFIN_URL` defaults to
  `http://host.docker.internal:8096`. Use the same host for the integrations, e.g.
  `SEERR_URL=http://host.docker.internal:5055`. If the apps only listen on `127.0.0.1` of the host, publish
  them on the host's LAN/bridge address instead (container → host traffic doesn't arrive on loopback).
- **Same compose network as your media stack.** Uncomment `networks: [default, media]` on the `jellyshell`
  service and the `networks:` block at the bottom (set `name:` to your stack's network from `docker network ls`),
  then use service names: `JELLYFIN_URL=http://jellyfin:8096`, `SEERR_URL=http://seerr:5055`, ...

### API keys from your *arr config dirs (optional)

Instead of copying keys into `.env`, mount the directory that holds the apps' config dirs read-only and set
`ARR_CONFIG_DIR`:

```yaml
    volumes:
      - /path/to/your/arr/stack:/arr:ro
```

```sh
ARR_CONFIG_DIR=/arr
ARR_HOST=host.docker.internal   # default in Docker; or leave URLs explicit
```

Expected layout: `/arr/seerr/config/settings.json`, `/arr/sonarr/config/config.xml`,
`/arr/radarr/config/config.xml`, `/arr/bazarr/config/config/config.yaml`, and Sonarr's `sonarr.db` for the
qBittorrent credentials. Explicit `*_API_KEY` / `*_URL` values win. Make sure uid 10001 can read the files.

### Subtitle backups

Before Bazarr overwrites a subtitle, the page server copies it to `<name>.jellyshell-bak`. That needs the
media files: mount them where Bazarr sees them (usually `/media`) and keep `MEDIA_PATH_MAP=/media=/media`, or
map a different prefix (`MEDIA_PATH_MAP=/data/media=/media`). The mount must be writable by uid 10001 for
backups; without it subtitle tools still work, just without backups.

## Public access (optional)

The page server has a second, hardened listener for exposing the UI to the internet through a reverse proxy /
Tailscale Funnel / Cloudflare Tunnel (deny-by-default routes, rate limits, security headers, no debug hooks).

```sh
# .env
JELLYSHELL_PUBLIC_PORT=8093
JELLYSHELL_PUBLIC_PREFIX=/jellyshell
# JELLYSHELL_PUBLIC_BIND stays empty: inside the container it defaults to 0.0.0.0, the publish below limits access.
```

Publish it from a `docker-compose.override.yml` next to `docker-compose.yml` (gitignored, picked up automatically by
`docker compose`, so `git pull` never conflicts with it):

```yaml
services:
  jellyshell:
    ports:
      - "127.0.0.1:8093:8093"   # host side: localhost only, for a proxy on this machine
```

Check it: `curl -s http://127.0.0.1:8093/jellyshell/api/config` answers, `curl -i http://127.0.0.1:8093/jellyshell/api/cmd`
is a 404 (debug hooks never exist on this listener).

Point the proxy's `/jellyshell` path at `http://127.0.0.1:8093` (prefix stripped or not, both work) and serve
Jellyfin at `/` of the same host, so the app and Jellyfin are same-origin. Details: [public-access.md](public-access.md).

## Dashboard notes

- Weather needs `DASH_LAT`/`DASH_LON`, photos `IMMICH_URL`/`IMMICH_API_KEY`, Calendar/Home the Mac agent and
  `DASH_PUSH_TOKEN`. Missing ones show "not configured" (or flagged sample data) instead of failing.
- Server tab: inside a container `/proc` is the container's view (CPU/RAM/load are host-wide on Linux; network
  is the container's interface). `DASH_DISKS` paths must be mounted into the container.
- Containers list (optional; grants read access to all container metadata): mount `/var/run/docker.sock:ro` **and**
  give uid 10001 the socket's group, or the list stays silently empty. Per-container CPU/RAM also needs the host
  cgroup tree:

  ```yaml
  services:
    dash:
      group_add: ["989"]     # stat -c %g /var/run/docker.sock
      cgroup: host
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock:ro
  ```
- Now playing: pyatv discovers devices by multicast, which needs `network_mode: host` on the `nowplaying`
  service; then set `NP_URL=http://host.docker.internal:8102` for the dash. In Docker the sidecar listens on all
  interfaces (the dash container reaches it through the Docker bridge), so on the host network port 8102 is open to
  your LAN as well: firewall it, or set `NP_BIND` to the bridge address (`ip -4 addr show docker0`, usually 172.17.0.1). With `NP_HOST` set to the device's IP a
  bridged container often works too.

## Building images by hand

```sh
docker build -t jellyshell .                                   # page server
docker build --target dash -t jellyshell-dash .
docker build --target nowplaying -t jellyshell-nowplaying .
docker run -d --name jellyshell -p 8097:8097 --add-host host.docker.internal:host-gateway \
  -e JELLYFIN_URL=http://host.docker.internal:8096 -v jellyshell-data:/data jellyshell
```

The healthcheck polls `GET /api/config`.

## Without Docker

```sh
cd web && npm ci && npm run build && cd ..
cp .env.example .env    # JELLYFIN_URL defaults to http://127.0.0.1:8096
python3 web-poc/server.py
```

systemd user units for this live in [`dash/deploy/`](../dash/deploy/) (`jellyshell.service`,
`jellyshell-dash.service`, `jellyshell-dash-nowplaying.service`).
