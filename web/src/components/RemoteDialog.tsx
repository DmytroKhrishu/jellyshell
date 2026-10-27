// Settings → Phone remote: pairing code + QR for the phone page (web/remote.html), and the list of paired phones.
// Portal + data-scope like UiServerDialog. B closes it. A new code is fetched on open and every time it expires.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import qrcode from 'qrcode-generator';
import { Icon } from './icons';
import { focusEl, focusFirst } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { dialogClosed, newCode, remoteEvent, remotes, unpair } from '../lib/remote';
import { relDay, fmtTime, dayKey, fmtDayDate } from '../lib/clock';
import '../styles/remote-pair.css';

const open = signal<{ invoker: HTMLElement | null } | null>(null);

export function openRemoteDialog() {
  open.value = { invoker: document.activeElement as HTMLElement | null };
}

function close() {
  const inv = open.value?.invoker;
  open.value = null;
  dialogClosed();
  if (inv?.isConnected) focusEl(inv);
}

export function RemoteDialog() {
  return open.value ? createPortal(<Pair />, document.getElementById('app') ?? document.body) : null;
}

/** Phone page address. On the public mount the document base is /jellyshell/, so a relative URL keeps the prefix. */
export const remotePageUrl = () => new URL('remote', document.baseURI).href;

function qrSvg(text: string) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

const seenLabel = (s: number) => {
  const k = dayKey(s * 1000);
  return `${relDay(k) ?? fmtDayDate(k)} ${fmtTime(s * 1000)}`;
};

function Pair() {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const since = useRef(Date.now());

  const refresh = () => {
    setErr('');
    newCode()
      .then((c) => setCode({ code: c.code, until: Date.now() + c.ttlMs }))
      .catch((e) => setErr(e?.status === 401 ? 'Sign in again to pair a phone.' : e?.status === 404 ? 'Phone remote is turned off on this server.' : 'Could not reach the JellyShell server.'));
  };
  useEffect(() => {
    refresh();
    requestAnimationFrame(() => focusEl(ref.current?.querySelector<HTMLElement>('[data-fkey="rp-close"]')) || focusFirst(ref.current));
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    const off = pushHandler((ev) => {
      if (ev.action === 'back' || ev.action === 'menu') {
        if (!ev.repeat) close();
        return true;
      }
      return false;
    });
    return () => {
      window.clearInterval(t);
      off();
    };
  }, []);
  useEffect(() => {
    if (code && now > code.until) refresh();
  }, [now]);
  // A phone just paired: the code is spent, get a fresh one (for a second phone).
  useEffect(() => {
    const e = remoteEvent.value;
    if (e?.kind === 'paired' && e.at > since.current) {
      since.current = e.at;
      refresh();
    }
  }, [remoteEvent.value]);

  const url = remotePageUrl();
  const qrUrl = code ? `${url}#${code.code}` : url;
  const left = code ? Math.max(0, Math.floor((code.until - now) / 1000)) : 0;
  const list = remotes.value ?? [];
  const justPaired = remoteEvent.value?.kind === 'paired' && now - remoteEvent.value.at < 6000 ? remoteEvent.value : null;

  return (
    <div class="rp-wrap">
      <div class="rp login-panel" data-scope ref={ref}>
        <h2>
          <Icon name="phone" /> Phone remote
        </h2>
        <div class="rp-body">
          <div class="rp-qr" dangerouslySetInnerHTML={{ __html: qrSvg(qrUrl) }} />
          <div class="rp-side">
            <p class="rp-hint">Scan with your phone's camera, or open</p>
            <div class="rp-url">{url.replace(/^https?:\/\//, '')}</div>
            <p class="rp-hint">and enter this code:</p>
            <div class={'rp-code' + (code ? '' : ' wait')}>{code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : err ? '— — —' : '· · ·'}</div>
            <div class="rp-ttl">{err || (code ? `New code in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Getting a code…')}</div>
            {justPaired && (
              <div class="rp-ok" role="status">
                <Icon name="check" /> {justPaired.name || 'Phone'} connected
              </div>
            )}
            <p class="rp-tip">Add it to your home screen for a full-screen remote (iPhone: Share → Add to Home Screen). Pairing is for this {isTvLabel()} only.</p>
            <div class="btn-row rp-btns">
              <div class="btn focusable" tabIndex={-1} data-fkey="rp-close" onClick={close}>
                Done
              </div>
              <div class="btn focusable" tabIndex={-1} data-fkey="rp-new" onClick={refresh}>
                <Icon name="restart" /> New code
              </div>
            </div>
          </div>
        </div>
        {list.length > 0 && (
          <div class="rp-list">
            <h3>Paired phones</h3>
            {list.map((r) => (
              <div class="rp-row focusable" tabIndex={-1} key={r.id} data-fkey={'rp-' + r.id} onClick={() => unpair(r.id).catch(() => {})}>
                <Icon name="phone" />
                <span class="rp-name">{r.name}</span>
                <span class="rp-seen">Last used {seenLabel(r.seen)}</span>
                <span class="rp-act">
                  <Icon name="trash" /> Remove
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const isTvLabel = () => (/Xbox/i.test(navigator.userAgent) || (window as any).chrome?.webview ? 'console' : 'screen');
