// JellyShell page-server addresses the Xbox shell loads its UI from (docs/bridge.md "UI servers").
// The shell reports them in capabilities `uiServers {media, dash, defaults {media, dash}}` (null = not set) and changes them
// with `setUiServer {side, url|null}` → reply `uiServer {side, ok, url, error?, uiServers}`. On success the shell re-resolves
// the side and, when it is the visible one, navigates there (this page goes away).
// An old shell sends no `uiServers`: the Settings rows and the ServerSetup field stay hidden.
// Desktop mock: `?uiservers=1` fakes a shell that accepts any address except ones containing "bad" (stored in localStorage).
import { signal } from '@preact/signals';
import { isNative, onNative, send } from './bridge';
import { log } from './log';

export type UiSide = 'media' | 'dash';

export interface UiServers {
  media: string | null;
  dash: string | null;
  defaults: { media: string | null; dash: string | null };
}

const MOCK = !isNative && new URLSearchParams(location.search).get('uiservers') === '1';
const MOCK_KEY = 'jellyshell.mockUiServers';

function mockState(): UiServers {
  try {
    const s = JSON.parse(localStorage.getItem(MOCK_KEY) || '');
    if (s && typeof s === 'object') return { media: s.media ?? null, dash: s.dash ?? null, defaults: { media: null, dash: null } };
  } catch {}
  return { media: null, dash: null, defaults: { media: null, dash: null } };
}

/** null = the shell can't change its page server (old shell, Android, plain browser). */
export const uiServers = signal<UiServers | null>(MOCK ? mockState() : null);

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function parse(v: any): UiServers | null {
  if (!v || typeof v !== 'object') return null;
  return { media: str(v.media), dash: str(v.dash), defaults: { media: str(v.defaults?.media), dash: str(v.defaults?.dash) } };
}

type Reply = { ok: boolean; error?: string };
const pending = new Map<UiSide, (r: Reply) => void>();

onNative((m: any) => {
  if (m.type === 'capabilities') {
    const u = parse(m.uiServers);
    if (u) uiServers.value = u;
  } else if (m.type === 'uiServer') {
    const u = parse(m.uiServers);
    if (u) uiServers.value = u;
    const side: UiSide = m.side === 'dash' ? 'dash' : 'media';
    pending.get(side)?.({ ok: m.ok === true, error: typeof m.error === 'string' ? m.error : undefined });
    pending.delete(side);
  }
});

/** Page-server address as the shell wants it: http(s), path ending in '/'. '' = not a usable address. */
export function normalizePageServer(s: string) {
  let v = s.trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    if (!u.hostname || u.username || u.password) return '';
    return u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/');
  } catch {
    return '';
  }
}

/** "192.168.1.10:8097" / "media.example.com/jellyshell" for display. */
export const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Save (url) or clear (null) a side's page server. Resolves when the shell answered (or after 10 s without an answer). */
export function setUiServer(side: UiSide, url: string | null): Promise<Reply> {
  log('setUiServer', { side, url });
  if (MOCK) {
    return new Promise((res) =>
      setTimeout(() => {
        if (url && url.includes('bad')) return res({ ok: false, error: 'No JellyShell server answered at that address.' });
        const s = { ...(uiServers.value ?? mockState()), [side]: url };
        localStorage.setItem(MOCK_KEY, JSON.stringify({ media: s.media, dash: s.dash }));
        uiServers.value = s;
        res({ ok: true });
      }, 600),
    );
  }
  if (!isNative) return Promise.resolve({ ok: false, error: 'Only the Xbox app can change its JellyShell server.' });
  pending.get(side)?.({ ok: false, error: 'Replaced by a newer request.' });
  return new Promise<Reply>((res) => {
    const t = setTimeout(() => {
      pending.delete(side);
      res({ ok: false, error: 'The app did not answer. Try again.' });
    }, 10_000);
    pending.set(side, (r) => {
      clearTimeout(t);
      res(r);
    });
    send({ type: 'setUiServer', side, url });
  });
}
