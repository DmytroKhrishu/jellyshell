// Per-user feature switches from the page server (GET api/config with the Jellyfin token → `capabilities`).
// The server enforces every rule itself; this only hides UI the user can't use (Downloads for non-admins,
// subtitle write tools, Requests for unlinked accounts on the public URL) and integrations the server doesn't have configured
// (no Seerr -> no Requests tab; no Sonarr/Radarr -> no Downloads/calendar; no Bazarr or Jellyfin API key -> no subtitle tools).
import { signal, effect } from '@preact/signals';
import { auth } from './jellyfin';
import { hiddenTabs, switchTab, tab } from './router';
import { log } from './log';
import { noPageServer } from './uisource';

export interface Caps {
  public: boolean;
  downloads: boolean;
  subtitleTools: boolean;
  requests: boolean;
  /** Seerr is configured on this server (older servers omit it: treat as true). */
  seerr?: boolean;
  /** HDR picture controls available (JELLYFIN_API_KEY set; older servers omit it). */
  picture?: boolean;
}

/** null until known: callers treat unknown as "allowed" so the LAN/Xbox experience never regresses on a slow fetch. */
export const caps = signal<Caps | null>(null);

/** Served under a sub-path of the public host (Tailscale Funnel: https://<host>/jellyshell/). */
export const isPublicMount = /^\/jellyshell(\/|$)/.test(location.pathname);

let seq = 0;
async function load() {
  const a = auth.value;
  const my = ++seq;
  if (!a?.token) {
    caps.value = null;
    hiddenTabs.value = [];
    return;
  }
  if (noPageServer()) {
    // Bundled: no page server, so none of its extras exist. Hide them without asking.
    caps.value = { public: false, downloads: false, subtitleTools: false, requests: false };
    hiddenTabs.value = ['requests', 'downloads'];
    if (hiddenTabs.value.includes(tab.value)) switchTab('home');
    return;
  }
  try {
    const r = await fetch('api/config', { cache: 'no-store', headers: { 'X-Jellyfin-Token': a.token, 'X-Jellyfin-User': a.userId } });
    const c = (await r.json())?.capabilities as Caps | undefined;
    if (my !== seq) return;
    caps.value = c ?? null;
    const hide: string[] = [];
    if (c && !c.downloads) hide.push('downloads');
    if (c && c.seerr === false) hide.push('requests');
    hiddenTabs.value = hide;
    if (hide.includes(tab.value)) switchTab('home');
    log('capabilities', c ?? null);
  } catch (e) {
    log('capabilities failed', String(e));
  }
}

effect(() => {
  void auth.value?.token;
  load();
});
