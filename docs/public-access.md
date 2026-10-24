# Public access (reverse proxy / Tailscale Funnel / Cloudflare Tunnel)

JellyShell can be shared over the internet next to Jellyfin, e.g. `https://media.example.com/` = Jellyfin and
`https://media.example.com/jellyshell/` = JellyShell. Same origin means the login screen can use the page's own host as
the Jellyfin server (set `JELLYFIN_PUBLIC_URL` to make that explicit).

Never expose the LAN listener (`JELLYSHELL_PORT`, default 8097) to the internet. Enable the hardened public listener instead:

```
JELLYSHELL_PUBLIC_PORT=8093          # 0 (default) = disabled
JELLYSHELL_PUBLIC_BIND=127.0.0.1     # only your proxy should reach it
JELLYSHELL_PUBLIC_PREFIX=/jellyshell # the sub-path your proxy mounts it on ('' for a dedicated host)
```

## How it's wired

```
internet ──https──> your proxy :443 (media.example.com)
                      ├─ /            -> http://127.0.0.1:8096   Jellyfin
                      └─ /jellyshell  -> http://127.0.0.1:8093   JellyShell PUBLIC listener
LAN / Xbox / TV  ──> http://<server>:8097                        JellyShell LAN listener
```

- `web-poc/server.py` runs both listeners in one process: handler `H` on the LAN port, `PublicH` on the public port.
- Some proxies strip the prefix (Tailscale `serve`/`funnel` does), some don't. `PublicH` accepts both forms and injects
  `<base href="<prefix>/">` into index.html, so relative assets and API calls resolve under the mount.
- Web app: Vite `base: './'`, every page-server call is page-relative (`api/config`, `log`, `api/seerr/*`, `api/subs/*`),
  manifest `start_url`/`scope` = `./`. Never add a leading-slash fetch to a page-server endpoint.

Examples:

```
# Tailscale Funnel (keeps an existing Jellyfin funnel on /)
sudo tailscale funnel --bg --https=443 --set-path /jellyshell http://127.0.0.1:8093
sudo tailscale funnel --https=443 --set-path /jellyshell off      # removes only this path

# Caddy
media.example.com {
  handle_path /jellyshell/* { reverse_proxy 127.0.0.1:8093 }
  reverse_proxy 127.0.0.1:8096
}
```

Cloudflare Tunnel works the same way (an ingress rule for `/jellyshell` → `http://127.0.0.1:8093`).

## What the public listener allows / blocks

| Path | Public | Notes |
|---|---|---|
| built UI (`/`, `/assets/*`, icons, manifest) | allowed | `.map` files 404 |
| `GET /api/config` | allowed | `capabilities` only with a valid Jellyfin token |
| `/api/seerr/*` | token required | requests need a **linked Seerr account** (no admin fallback); Seerr user objects scrubbed to id/displayName/avatar |
| `GET /api/downloads`, `/api/calendar` | **admins only** | also admin-only on LAN |
| `/api/subs/*` | **admins only** | download/sync/delete admin-only on LAN too |
| `POST /log` | allowed, capped | ≤ 8 KB, 20 lines, 1/s per IP (burst 30), lines tagged `[public]` |
| `GET /log`, `/api/cmd`, `/snap`, `..` | **404** | never exist publicly |
| PUT/PATCH/OPTIONS/HEAD | 405 | |

Guards (web-poc/access.py): per-IP token bucket (15 req/s, burst 300; POST/DELETE 1 per 5 s, burst 10; client IP = the
LAST `X-Forwarded-For` hop), request bodies > 64 KB → 413, 5xx upstream errors replaced by `upstream error` (no paths or
stack traces), server tracebacks suppressed. Security headers on every public response: CSP (`default-src 'self'`,
`img-src` + `https://image.tmdb.org`, `media-src`/`worker-src` + `blob:` for hls.js, `frame-ancestors 'none'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`.

## Per-user capabilities

`GET api/config` with `X-Jellyfin-Token` returns `capabilities` (web/src/lib/caps.ts). Downloads and subtitle tools are
Jellyfin-admin only; on the public listener the Request button needs a Seerr account linked to the Jellyfin user. The
server enforces every rule; the UI flags only hide UI.

Friends who should be able to request: import their Jellyfin user in Seerr (Users → Import Jellyfin Users), or enable
"Enable New Jellyfin Sign-In" in Seerr so they're created on first login.
