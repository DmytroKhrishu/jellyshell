// Settings → "JellyShell server" editor (Xbox shell only): change or clear the page-server address of one side.
// Opened from Settings; rendered through a portal so the fixed overlay isn't trapped inside the settings scroller's transform.
// B closes it. Save probes the address natively first (docs/bridge.md "UI servers"); a media change reloads the app there.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Icon } from './icons';
import { TextField } from '../pages/Login';
import { focusEl, focusFirst } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { normalizePageServer, setUiServer, shortUrl, uiServers, UiSide } from '../lib/uiservers';
import { showToast } from './Dialog';
import '../styles/uiservers.css';

const editing = signal<{ side: UiSide; invoker: HTMLElement | null } | null>(null);

export function openUiServerDialog(side: UiSide) {
  editing.value = { side, invoker: document.activeElement as HTMLElement | null };
}

function close() {
  const inv = editing.value?.invoker;
  editing.value = null;
  if (inv?.isConnected) focusEl(inv);
}

export const UI_SERVER_EXAMPLE = 'http://192.168.1.10:8097';

/** Settings value text for a side: the saved address, else the build default, else "Not set". */
export function uiServerLabel(side: UiSide) {
  const u = uiServers.value;
  if (!u) return '';
  if (u[side]) return shortUrl(u[side]!);
  if (u.defaults[side]) return 'Default · ' + shortUrl(u.defaults[side]!);
  return side === 'media' ? 'Not set · built-in app' : 'Not set';
}

export function UiServerDialog() {
  const e = editing.value;
  return e ? createPortal(<Editor key={e.side} side={e.side} />, document.getElementById('app') ?? document.body) : null;
}

function Editor({ side }: { side: UiSide }) {
  const cur = uiServers.value;
  const [addr, setAddr] = useState(cur?.[side] ?? '');
  const [busy, setBusy] = useState<'' | 'save' | 'clear'>('');
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const def = cur?.defaults[side] ?? null;

  useEffect(() => {
    requestAnimationFrame(() => focusFirst(ref.current));
    return pushHandler((ev) => {
      if (ev.action === 'back' || ev.action === 'menu') {
        close();
        return true;
      }
      return false;
    });
  }, []);

  async function save(url: string | null) {
    if (busy) return;
    let v: string | null = null;
    if (url !== null) {
      v = normalizePageServer(url);
      if (!v) {
        setErr(`Enter a full address, for example ${UI_SERVER_EXAMPLE}`);
        return;
      }
    }
    setBusy(v === null ? 'clear' : 'save');
    setErr('');
    const r = await setUiServer(side, v);
    setBusy('');
    if (!r.ok) {
      setErr(r.error || 'The app could not use that address.');
      return;
    }
    close();
    showToast(v ? `JellyShell server set to ${shortUrl(v)}` : 'JellyShell server cleared', 3000);
  }

  const title = side === 'media' ? 'JellyShell server' : 'Dash server';
  return (
    <div class="uis-wrap">
      <div class="uis login-panel" data-scope ref={ref}>
        <h2>
          <Icon name={side === 'media' ? 'server' : 'dash'} /> {title}
        </h2>
        <p class="uis-hint">
          {side === 'media'
            ? 'The JellyShell page server adds Requests, Downloads and subtitle tools. Without one the app uses its built-in UI.'
            : 'Address of the Dash page server (optional TV dashboard).'}{' '}
          Example: {UI_SERVER_EXAMPLE}
          {def && (
            <>
              <br />
              Built-in default: {shortUrl(def)}
            </>
          )}
        </p>
        <TextField label="Address" value={addr} onInput={setAddr} type="url" inputMode="url" enterKeyHint="go" placeholder={UI_SERVER_EXAMPLE} onEnter={() => save(addr)} autofocus />
        {err && (
          <div class="err" role="alert">
            {err}
          </div>
        )}
        <div class="uis-btns">
          <div class={'btn focusable btn-primary' + (busy === 'save' ? ' busy' : '')} tabIndex={-1} data-fkey="uis-save" onClick={() => save(addr)}>
            {busy === 'save' ? (
              <>
                <span class="spinner" /> Checking…
              </>
            ) : (
              <>
                <Icon name="check" /> Save
              </>
            )}
          </div>
          {cur?.[side] && (
            <div class={'btn focusable' + (busy === 'clear' ? ' busy' : '')} tabIndex={-1} data-fkey="uis-clear" onClick={() => save(null)}>
              {busy === 'clear' ? <span class="spinner" /> : <Icon name="trash" />} {def ? 'Use default' : 'Clear'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
