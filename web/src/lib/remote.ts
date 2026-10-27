// Phone remote, TV side (docs/remote.md). This JellyShell instance is a "host" on the page server's relay
// (web-poc/remote_relay.py): a random id + secret kept in localStorage, so pairing belongs to this console/browser,
// not to a Jellyfin account. Settings → Phone remote shows a 6-digit code + QR; the phone page (web/remote.html) pairs
// with it and sends presses, which land here through a long poll and go through the normal input path (injectPress).
// The host only polls while at least one phone is paired (or the pairing dialog is open), so plain browser tabs cost nothing.
import { signal } from '@preact/signals';
import { auth } from './jellyfin';
import { Action, injectPress } from './input';
import { noPageServer } from './uisource';
import { current, focusEl } from './focus';
import { playerActive, switchTab, tab } from './router';
import { log } from './log';
import { isNative } from './bridge';

const HOST_KEY = 'jellyshell.remoteHost';
const ACTIONS = new Set<Action>(['up', 'down', 'left', 'right', 'select', 'back', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'menu', 'view']);

export interface PairedPhone {
  id: string;
  name: string;
  created: number;
  seen: number;
}
/** Phones paired with this instance (refreshed by the pairing dialog and after pair/unpair events). */
export const remotes = signal<PairedPhone[] | null>(null);
/** Last pairing event, for the dialog ("iPhone connected"). */
export const remoteEvent = signal<{ kind: 'paired' | 'unpaired'; name?: string; at: number } | null>(null);

/** Player hook: the phone's dedicated play/pause button + "now playing" line. */
export const nowPlaying = signal<{ title: string; sub?: string; paused: boolean; toggle: () => void } | null>(null);

function host(): { id: string; key: string } {
  try {
    const h = JSON.parse(localStorage.getItem(HOST_KEY) || '');
    if (h?.id && h?.key) return h;
  } catch {}
  const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const h = { id: 'h' + rnd(12), key: rnd(24) };
  localStorage.setItem(HOST_KEY, JSON.stringify(h));
  return h;
}

const UA = navigator.userAgent;
export const hostName = () =>
  isNative || /Xbox/i.test(UA) ? 'Xbox' : /JellyShellTV\//.test(UA) ? 'Android TV' : /iPhone|iPad|Android/i.test(UA) ? 'Phone' : 'Browser';

async function call<T = any>(path: string, init: RequestInit & { jf?: boolean } = {}): Promise<T> {
  const h = host();
  const a = auth.value;
  const res = await fetch('api/remote/' + path, {
    ...init,
    cache: 'no-store',
    headers: {
      'X-Remote-Host': h.id,
      'X-Remote-Key': h.key,
      ...(init.jf && a ? { 'X-Jellyfin-Token': a.token, 'X-Jellyfin-User': a.userId } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j?.error || `HTTP ${res.status}`), { status: res.status });
  return j as T;
}

let registered = false;
async function register() {
  const h = host();
  const r = await call<{ remotes: PairedPhone[] }>('host', { method: 'POST', jf: true, body: JSON.stringify({ id: h.id, key: h.key, name: hostName() }) });
  registered = true;
  remotes.value = r.remotes;
  if (r.remotes.length) localStorage.setItem(HOST_KEY + '.paired', '1');
  return r;
}

/** Pairing dialog: register (needs a signed-in user) and get a fresh code. Starts polling so the pairing lands at once. */
export async function newCode(): Promise<{ code: string; ttlMs: number }> {
  await register();
  wantPoll = true;
  startPolling();
  return call('code', { method: 'POST' });
}

export async function refreshRemotes() {
  if (!registered) return void (await register());
  remotes.value = (await call<{ remotes: PairedPhone[] }>('remotes')).remotes;
}

export async function unpair(id: string | 'all') {
  remotes.value = (await call<{ remotes: PairedPhone[] }>('remotes/' + encodeURIComponent(id), { method: 'DELETE' })).remotes;
  if (!remotes.value.length) localStorage.removeItem(HOST_KEY + '.paired');
}

// ---------------- poll loop ----------------
let polling = false;
let wantPoll = false;
let seq = -1;

export function startPolling() {
  if (polling || noPageServer() || !auth.value) return;
  polling = true;
  void loop();
}

/** Called by the pairing dialog on close: keep polling only if a phone is paired. */
export function dialogClosed() {
  wantPoll = false;
}

async function loop() {
  let fails = 0;
  let idle = 0;
  try {
    if (!registered) await register();
  } catch (e) {
    log('remote: register failed', String(e));
    polling = false;
    return;
  }
  while (auth.value && !noPageServer()) {
    try {
      const r = await call<{ seq: number; cmds: any[]; remotes: number }>('poll?since=' + seq);
      fails = 0;
      const first = seq < 0;
      seq = r.seq;
      if (!first) for (const c of r.cmds) await run(c);
      if (r.remotes > 0) {
        idle = 0;
        localStorage.setItem(HOST_KEY + '.paired', '1');
        pushState();
      } else if (!wantPoll && ++idle > 1) {
        localStorage.removeItem(HOST_KEY + '.paired');
        break; // nobody paired and no dialog open: stop
      }
    } catch (e: any) {
      if (e?.status === 401) registered = false; // relay lost us (data reset): re-register
      if (e?.status === 404) break; // remote turned off on this server
      try {
        if (!registered) await register();
      } catch {}
      await new Promise((res) => setTimeout(res, Math.min(15000, 1000 * 2 ** fails++)));
    }
  }
  polling = false;
}

// ---------------- commands ----------------
function textTarget(): HTMLInputElement | null {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return a as HTMLInputElement;
  return current()?.querySelector<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]), textarea') ?? null;
}

const setValue = (el: HTMLInputElement, v: string) => {
  // Through the native setter so Preact's onInput sees a real change.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

async function run(c: any) {
  if (c.sys === 'paired' || c.sys === 'unpaired') {
    remoteEvent.value = { kind: c.sys, name: c.name, at: Date.now() };
    log('remote:', c.sys, c.name ?? '');
    void refreshRemotes().catch(() => {});
    if (c.sys === 'paired') import('../components/Dialog').then((d) => d.showToast(`Phone remote connected${c.name ? ': ' + c.name : ''}`, 3000));
    return;
  }
  if (ACTIONS.has(c.a)) return injectPress(c.a, c.t === 'down' || c.t === 'up' ? c.t : 'tap');
  if (c.playpause) {
    if (nowPlaying.value) nowPlaying.value.toggle();
    else injectPress('select', 'tap');
    return;
  }
  if (typeof c.text === 'string') {
    let el = textTarget();
    if (!el && !playerActive.value) {
      // Typing with nothing to type into: go to Search (the only free-text field on the tabs).
      if (tab.value !== 'search' || !document.querySelector('.page.active input')) switchTab('search');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el = document.querySelector<HTMLInputElement>('.page.active input');
      const wrap = el?.closest<HTMLElement>('.focusable');
      if (wrap) focusEl(wrap);
    }
    if (el) setValue(el, c.text);
    pushState();
    return;
  }
  if (c.key === 'clear') {
    const el = textTarget();
    if (el) setValue(el, '');
    return;
  }
  if (c.key === 'enter') {
    const el = textTarget();
    if (!el) return injectPress('select', 'tap');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    (ev as any).jsRemote = true; // lib/input.ts lets it through to the field
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented) el.form?.requestSubmit();
  }
}

// ---------------- state for the phone ----------------
let stateTimer = 0;
let lastState = '';
function snapshot() {
  const el = textTarget();
  const label = el ? el.getAttribute('aria-label') || el.closest('.field')?.querySelector('label')?.textContent || el.placeholder || 'Text' : '';
  const np = nowPlaying.value;
  return {
    text: el ? { label: label.trim().slice(0, 60), value: el.type === 'password' ? '' : el.value.slice(0, 500), secret: el.type === 'password' } : null,
    player: np ? { title: np.title.slice(0, 120), sub: np.sub?.slice(0, 120), paused: np.paused } : null,
  };
}
export function pushState() {
  if (!polling || stateTimer) return;
  stateTimer = window.setTimeout(() => {
    stateTimer = 0;
    const s = JSON.stringify(snapshot());
    if (s === lastState) return;
    lastState = s;
    call('state', { method: 'POST', body: s }).catch(() => (lastState = ''));
  }, 150);
}
document.addEventListener('focusin', pushState);
document.addEventListener('focusout', pushState);
document.addEventListener('input', pushState);
nowPlaying.subscribe(pushState);

// Resume polling on launch when this instance already has paired phones.
auth.subscribe((a) => {
  if (a && localStorage.getItem(HOST_KEY + '.paired') === '1') startPolling();
});
