// Phone remote: talks to the page server's relay (web-poc/remote_relay.py) with a token bound to ONE paired TV.
// The token lives in localStorage AND a cookie: iOS copies Safari's cookies (not its localStorage) into a Home Screen
// web app when it is created, so pairing in Safari and then "Add to Home Screen" keeps the pairing.
import { signal } from '@preact/signals';
import type { PlayerOp, PlayerState } from '../lib/remote';

const TOKEN_KEY = 'jsr.token';
const HOST_KEY = 'jsr.host';
const COOKIE = 'jsr_token';

export interface TvState {
  text: { label: string; value: string; secret: boolean } | null;
  player: PlayerState | null;
}

function readCookie() {
  const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function writeCookie(v: string) {
  const path = location.pathname.replace(/[^/]*$/, '') || '/';
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(v)}; Path=${path}; Max-Age=${v ? 400 * 86400 : 0}; SameSite=Strict${secure}`;
}

export const token = signal<string>(localStorage.getItem(TOKEN_KEY) || readCookie());
export const hostName = signal<string>(localStorage.getItem(HOST_KEY) || 'TV');
export const online = signal<boolean | null>(null);
export const tv = signal<TvState | null>(null);
/** performance.now() when `tv` last arrived: the Now Playing panel interpolates the position from there. */
export const tvAt = signal(0);
/** Lock screen controls are on: keep watching the TV while the page is hidden (the silent audio keeps the page alive). */
export const keepAwake = signal(false);
export const netError = signal(false);

if (token.value && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, token.value);

function setToken(t: string, name?: string) {
  token.value = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  writeCookie(t);
  if (name) {
    hostName.value = name;
    localStorage.setItem(HOST_KEY, name);
  }
}

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch('api/remote/' + path, {
    ...init,
    cache: 'no-store',
    headers: { 'X-Remote-Token': token.value, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'pair') {
    setToken('');
    tv.value = null;
    online.value = null;
  }
  if (!res.ok) throw Object.assign(new Error(j?.error || `Error ${res.status}`), { status: res.status });
  return j;
}

export function phoneName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser';
}

export async function pair(code: string) {
  const r = await req('pair', { method: 'POST', body: JSON.stringify({ code, name: phoneName() }) });
  setToken(r.token, r.host?.name);
  online.value = true;
  startWatch();
}

export async function unpairSelf() {
  try {
    await req('self', { method: 'DELETE' });
  } catch {}
  setToken('');
  tv.value = null;
}

// ---------------- sending: one request in flight, everything queued meanwhile goes in the next batch (keeps order) ----------------
type Cmd = { a: string; t: 'tap' | 'down' | 'up' } | { text: string } | { key: 'enter' | 'clear' } | { playpause: true } | { player: PlayerOp };
let queue: Cmd[] = [];
let inFlight = false;

export function send(c: Cmd) {
  if (!token.value) return;
  // Typing sends the whole field value: only the newest one matters.
  if ('text' in c) queue = queue.filter((q) => !('text' in q));
  // Seeks (seek bar drag) and boost / picture picks: the newest one wins too (brightness and contrast separately).
  const k = (o: PlayerOp) => o.op + (o.op === 'pic' ? ('b' in o ? 'b' : 'c') : '');
  if ('player' in c && ['seek', 'boost', 'pic'].includes(c.player.op)) queue = queue.filter((q) => !('player' in q && k(q.player) === k(c.player)));
  queue.push(c);
  void flush();
}

async function flush() {
  if (inFlight || !queue.length) return;
  inFlight = true;
  const cmds = queue;
  queue = [];
  try {
    const r = await req('send', { method: 'POST', body: JSON.stringify({ cmds }) });
    netError.value = false;
    online.value = !!r.online;
  } catch (e: any) {
    if (e?.status !== 401) netError.value = true;
  }
  inFlight = false;
  if (queue.length) void flush();
}

// ---------------- watching the TV: online + focused text field + now playing ----------------
let watching = false;
export function startWatch() {
  if (watching || !token.value) return;
  watching = true;
  void (async () => {
    let v = 0;
    let fails = 0;
    while (token.value) {
      if (document.hidden && !keepAwake.value) {
        await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
        v = 0; // re-read the state right away after the phone wakes up
        continue;
      }
      try {
        const r = await req('watch?v=' + v);
        v = r.v;
        fails = 0;
        netError.value = false;
        online.value = r.online;
        tv.value = r.state;
        tvAt.value = performance.now();
        if (r.name && r.name !== hostName.value) {
          hostName.value = r.name;
          localStorage.setItem(HOST_KEY, r.name);
        }
      } catch (e: any) {
        if (e?.status === 401) break;
        netError.value = true;
        await new Promise((res) => setTimeout(res, Math.min(8000, 500 * 2 ** fails++)));
      }
    }
    watching = false;
  })();
}
