// Bundled (packaged, no page server) first run: ask for the Jellyfin server address before sign-in.
// The address is checked with GET /System/Info/Public and saved as `jellyshell.server`, which Login reads.
// Optional second field (Xbox shell that reports `uiServers`): the JellyShell page server for Requests/Downloads/subtitle
// tools. It is sent as `setUiServer` (docs/bridge.md "UI servers"); on success the shell reloads onto that server.
import { signal } from '@preact/signals';
import '../styles/uiservers.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { TextField } from '../pages/Login';
import { serverInfo } from '../lib/jellyfin';
import { focusEl, focusFirst } from '../lib/focus';
import { log } from '../lib/log';
import { BUNDLED_DEFAULT_SERVER, noPageServer } from '../lib/uisource';
import { normalizePageServer, setUiServer, uiServers } from '../lib/uiservers';
import { UI_SERVER_EXAMPLE } from './UiServerDialog';

const SERVER_KEY = 'jellyshell.server';

/** True until a bundled build has a saved server address (page-server builds already know their Jellyfin). */
export const needsServerSetup = signal(noPageServer() && !localStorage.getItem(SERVER_KEY));

export function normalizeServer(s: string) {
  let v = s.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  if (!/:\d+$/.test(v.replace(/^https?:\/\//, '')) && /^http:/i.test(v)) v += ':8096';
  return v;
}

export function ServerSetup() {
  const [addr, setAddr] = useState(BUNDLED_DEFAULT_SERVER);
  const [page, setPage] = useState('');
  const canPage = uiServers.value !== null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => focusEl(panel.current?.querySelector<HTMLElement>('[data-fkey="srv-connect"]')) || focusFirst(panel.current));
  }, []);

  async function connect() {
    if (busy) return;
    const v = normalizeServer(addr);
    if (!v) {
      setErr('Enter your Jellyfin server address.');
      return;
    }
    const p = canPage && page.trim() ? normalizePageServer(page) : '';
    if (canPage && page.trim() && !p) {
      setErr(`Enter a full JellyShell server address, for example ${UI_SERVER_EXAMPLE}, or leave it empty.`);
      return;
    }
    setBusy(true);
    setErr('');
    let info;
    try {
      info = await serverInfo(v);
    } catch (e) {
      log('server setup failed', String(e));
      setErr(`No Jellyfin server answered at ${v.replace(/^https?:\/\//, '')}. Check the address and that the Xbox is on the same network.`);
      setBusy(false);
      return;
    }
    localStorage.setItem(SERVER_KEY, v);
    log('server setup ok', { server: v, name: info.ServerName, version: info.Version });
    if (p) {
      // Success = the shell navigates to the page server (this page goes away); failure = stay here with the reason.
      const r = await setUiServer('media', p);
      if (!r.ok) {
        setErr(`JellyShell server: ${r.error || 'not reachable.'} Fix it, or clear the field to use the built-in app.`);
        setBusy(false);
        return;
      }
    }
    needsServerSetup.value = false;
  }

  return (
    <div class="login">
      <div class="login-brand">
        <h1>
          Jelly<span>Shell</span>
        </h1>
        <p class="login-tag">Your Jellyfin library, made for the couch.</p>
      </div>
      <div class="login-panel srv-setup" ref={panel} data-scope>
        <h2>
          <Icon name="server" /> Server address
        </h2>
        <p class="srv-setup-hint">Where your Jellyfin server lives, for example http://192.168.1.10:8096.</p>
        <TextField label="Server" value={addr} onInput={setAddr} type="url" inputMode="url" enterKeyHint="go" placeholder="http://192.168.1.10:8096" onEnter={connect} />
        {canPage && (
          <>
            <p class="srv-setup-opt">JellyShell server (optional, for Requests/Downloads/subtitles)</p>
            <TextField label="JellyShell" value={page} onInput={setPage} type="url" inputMode="url" enterKeyHint="go" placeholder={UI_SERVER_EXAMPLE} onEnter={connect} />
          </>
        )}
        {err && (
          <div class="err" role="alert">
            {err}
          </div>
        )}
        <div class={'btn focusable btn-primary' + (busy ? ' busy' : '')} tabIndex={-1} data-fkey="srv-connect" onClick={connect}>
          {busy ? (
            <>
              <span class="spinner" /> Connecting…
            </>
          ) : (
            'Connect'
          )}
        </div>
      </div>
    </div>
  );
}
