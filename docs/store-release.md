# Store release: JellyShell (merged Media + Dash), contract

The goal is to ship one Microsoft Store app, installed in RETAIL mode, as a Private audience listing. Dev Mode is then only needed to test native changes before submitting them.

## Store identity (Partner Center)
Reserve the app name in Partner Center, then copy Product management > Product identity into these repository
VARIABLES (Settings > Secrets and variables > Actions > Variables). `build-store.yml` fails at its first step when one is
missing; nothing identity-related is committed.
- `STORE_NAME` = Package/Identity/Name (e.g. `Contoso.JellyShell`)
- `STORE_PUBLISHER` = Package/Identity/Publisher (`CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)
- `STORE_PUBLISHER_DISPLAY` = Package/Properties/PublisherDisplayName
- `STORE_PHONE_PRODUCT_ID` = any GUID, generated once and never changed (`mp:PhoneIdentity`)
- `STORE_DISPLAY` (optional) = DisplayName, default `JellyShell`. Only the Xbox device family. Category: Entertainment.
- The dev sideload build (`build.yml`) uses `JellyShell.Sideload` (or `vars.SIDELOAD_IDENTITY`) / `CN=JellyShellDev`,
  so both builds can be installed side by side.
- Optional page-server defaults baked into the Store build: the same `JELLYSHELL_MEDIA_URL` / `JELLYSHELL_DASH_URL` /
  `JELLYSHELL_PUBLIC_URL` secrets or variables as the sideload build (docs/building.md). Without them the Store app
  starts on its bundled UI and the user enters the servers in the first-run screen / Settings.

## One app, two sides
- **media**: the current JellyShell web UI (page server :8097, `web/`).
- **dash**: the current Xbox Dash web UI (page server :8098, source `dash/`).
- Only one WebView/side is loaded at a time, because the app has about 180 MB of headroom. Switching navigates the single WebView2.
- Users switch with the **View button (keyCode 208)** anywhere outside the player and text inputs, or with a **Dash pill** at the end of the Media tab bar and a **Media pill** at the end of the Dash tab bar.
- A setting chooses the start side ("Open on: Media / Dash"). The default is media.

## UI source order (native resolves per side at launch/switch; details in docs/bridge.md "Sides")
1. The page-server address the user saved (first-run screen or Settings → JellyShell server; bridge `setUiServer`).
2. The build-time defaults: media `JELLYSHELL_MEDIA_URL`, then the public `JELLYSHELL_PUBLIC_URL` (media only: a
   reverse-proxied https URL reachable from anywhere, which is also what a certification tester outside your network
   would reach); dash `JELLYSHELL_DASH_URL`. Probed with a GET (2.5 s for http, 4 s for https).
3. Bundled: `web/dist` is copied into the package (`ui/` content folder) and served via WebView2 `SetVirtualHostNameToFolderMapping("app.jellyshell", ..., Allow)` → `http://app.jellyshell/index.html`. Media only. In bundled mode the page-server extras (Requests, Downloads, subtitle tools, picture, api/config, log) are unavailable, and the UI must degrade without errors.
- Dash unreachable → native shows the media side and sends `sideUnavailable` (see below). The web side shows a toast ("Dash needs your home server").

## Bridge additions (extend docs/bridge.md, v1 stays compatible)
web → native
- `{type:'switchSide', side:'media'|'dash'}`: native navigates the WebView to that side's resolved URL.
- `{type:'setStartSide', side:'media'|'dash'}`: persisted in LocalSettings `startSide`.
- `{type:'setUiServer', side, url|null}`: save/clear the page-server address (reply `uiServer`).

native → web (fields added to the existing hello/capabilities message the shell already sends)
- `side: 'media'|'dash'`, `startSide`, `sides: {media: true, dash: <bool reachable>}`, `uiSource: 'saved'|'default'|'public'|'bundled'|'none'`, `uiServers` (see docs/bridge.md "UI servers").
- `{type:'sideUnavailable', side:'dash'}`
- The web side must also work with an OLD shell that sends none of this. Hide the Dash pill when `sides` is absent.
