// Where this UI was loaded from (docs/store-release.md "UI source order"). No imports: jellyfin.ts, log.ts and
// input.ts read it at module load, before anything else exists.
//
// - saved / default / public (older shells: lan): served by web-poc/server.py, so the page-server extras (api/config, log, api/cmd, Requests,
//   Downloads, subtitle tools, picture) exist.
// - bundled: web/dist packaged inside the Store app and mapped by WebView2 to the virtual host `app.jellyshell`.
//   No page server at all: every extra must be skipped quietly (no fetch, no toast, no console error).
//   `?bundled=1` forces this on a plain static server (python3 -m http.server) for desktop testing.
const q = new URLSearchParams(location.search);

/** Known synchronously at boot: the bundled virtual host, or the desktop test override. */
export const bundledAtBoot = location.hostname === 'app.jellyshell' || q.get('bundled') === '1';

let bundled = bundledAtBoot;
/** The shell reported `uiSource:'bundled'` (hello/capabilities). Only ever turns bundled mode ON. */
export function markBundled() {
  bundled = true;
}
/** True when there is no page server behind this page. */
export const noPageServer = () => bundled;

/** Jellyfin address prefilled when nothing is saved yet in bundled mode: none (ServerSetup asks; its field shows an example). */
export const BUNDLED_DEFAULT_SERVER = '';
