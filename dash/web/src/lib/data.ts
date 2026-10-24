// Shared data store: every source is polled once and read by any page via signals.
import { signal } from '@preact/signals';

export interface CalEvent {
  title: string;
  start: string;
  end: string;
  calendar: string;
  color?: string;
  url?: string | null;
  location?: string | null;
  allDay?: boolean;
}
export interface Photo { id: string; taken?: string; place?: string }

export const weather = signal<any>(null);
export const calendar = signal<{ mock?: boolean; updatedAt: number; events: CalEvent[] } | null>(null);
export const home = signal<any>(null);
export const server = signal<any>(null);
export const photos = signal<{ memories: { title: string; assets: Photo[] }[]; favorites: Photo[]; random: Photo[] } | null>(null);
/** Sources the server reports as not set up (503 {configured:false}): url -> reason. Pages show it instead of "Loading…". */
export const unconfigured = signal<Record<string, string>>({});
// The Xbox WebView reports the console's zone (often US Pacific), not the household's. Everything runs on "wall" Dates:
// a Date whose LOCAL fields equal the household's wall clock. Calendar times are converted on fetch;
// Open-Meteo times are already offset-less local strings, so they parse as wall time directly.
// Zone: the dash server's (GET /api/config timeZone: DASH_TZ / TZ / host zone), then the weather location's; UTC until known.
let TZ = 'UTC';
function setZone(tz?: string) {
  if (!tz || tz === TZ) return;
  try {
    fmt(tz);
    TZ = tz;
    now.value = wall();
  } catch {
    /* unknown zone: keep the current one */
  }
}
const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(tz, f);
  }
  return f;
};
/** Any instant -> a Date whose local fields read as the household's wall time. Only format/compare these, never send them anywhere. */
export const wall = (x: Date | string | number = Date.now()) => {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(TZ).formatToParts(new Date(x))) p[type] = +value;
  return new Date(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
};
const wallIso = (x: string) => {
  const d = wall(x);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const now = signal(wall());
export interface Backdrop { file: string; name: string; artist: string; license: string }
export const backdrops = signal<Backdrop[]>([]);

function poll(sig: { value: any }, url: string, ms: number, map: (v: any) => any = (v) => v) {
  const run = async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        sig.value = map(await r.json());
        if (unconfigured.value[url]) {
          const { [url]: _, ...rest } = unconfigured.value;
          unconfigured.value = rest;
        }
      } else if (r.status === 503) {
        const e = await r.json().catch(() => null);
        if (e?.configured === false) unconfigured.value = { ...unconfigured.value, [url]: e.error || 'not configured' };
      }
    } catch {
      /* keep last value */
    }
  };
  run();
  setInterval(run, ms);
}

let zoneFromServer = false;
export function startData() {
  fetch('/api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      if (c?.timeZone) {
        zoneFromServer = true;
        setZone(c.timeZone);
      }
    })
    .catch(() => {});
  poll(weather, '/api/weather', 10 * 60_000, (w) => {
    if (!zoneFromServer) setZone(w?.timezone);
    // Date-only strings ("2026-10-14") parse as UTC midnight, which is the previous day west of Greenwich: make them local.
    if (w?.daily?.time) w.daily.time = w.daily.time.map((t: string) => (t.length === 10 ? t + 'T00:00' : t));
    return w;
  });
  // All-day events too: EventKit sends them as local midnight with an offset, which the WebView would shift a day back.
  poll(calendar, '/api/calendar', 60_000, (c) => ({
    ...c,
    events: (c.events ?? []).map((e: CalEvent) => ({ ...e, start: wallIso(e.start), end: wallIso(e.end) })),
  }));
  poll(home, '/api/home', 30_000);
  poll(server, '/api/server', 5_000);
  poll(photos, '/api/photos', 15 * 60_000);
  poll(backdrops, '/api/backdrops', 30 * 60_000);
  refreshNowPlaying();
  poll(settings, '/api/settings', 60_000);
  setInterval(() => (now.value = wall()), 5_000);
}

export const photoUrl = (id: string, size: 'thumbnail' | 'preview' = 'preview') => `/api/photo/${id}?size=${size}`;

// ---------- UI settings (server-stored, shared by every client) ----------
export interface Settings { idleMinutes: number; idleEnabled: boolean }
export const settings = signal<Settings>({ idleMinutes: 3, idleEnabled: true });
export async function saveSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch }; // optimistic
  try {
    const r = await fetch('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    if (r.ok) settings.value = await r.json();
  } catch {
    /* keep optimistic value */
  }
}

// ---------- HomePod now playing (server proxies the pyatv sidecar) ----------
export interface NowPlaying {
  available: boolean;
  /** false: the server has no sidecar configured (NP_DEVICE_ID / NP_URL unset). */
  configured?: boolean;
  device: string;
  device_state: 'idle' | 'playing' | 'paused' | 'loading' | 'seeking' | 'stopped' | string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  position?: number | null;
  total_time?: number | null;
  sampled_at?: number;
  now?: number;
  volume?: number | null;
  app?: string | null;
  shuffle?: string;
  repeat?: string;
  artwork_url?: string | null;
  mock?: boolean;
  error?: string;
  /** client-side: Date.now()/1000 minus server time at fetch, to interpolate position */
  skew?: number;
}
export const nowPlaying = signal<NowPlaying | null>(null);
/** Music tab polls every 2 s; elsewhere 5 s. */
export const npFast = signal(false);
const NP_MOCK = new URLSearchParams(location.search).get('mock'); // dev-only layout aid: ?mock=1 | ?mock=idle
let npTimer: ReturnType<typeof setTimeout> | undefined;

export async function refreshNowPlaying() {
  clearTimeout(npTimer);
  try {
    const r = await fetch('/api/nowplaying' + (NP_MOCK ? `?mock=${encodeURIComponent(NP_MOCK)}` : ''), { cache: 'no-store' });
    if (r.ok) {
      const v: NowPlaying = await r.json();
      v.skew = Date.now() / 1000 - (v.now ?? Date.now() / 1000);
      nowPlaying.value = v;
    }
  } catch {
    /* keep last value */
  }
  npTimer = setTimeout(refreshNowPlaying, npFast.value ? 2_000 : 5_000);
}
npFast.subscribe(() => npTimer !== undefined && refreshNowPlaying());

export const npActive = (n: NowPlaying | null): boolean =>
  !!n && n.available && !!n.title && ['playing', 'paused', 'loading', 'seeking'].includes(n.device_state);

/** Interpolated elapsed seconds at client time `at` (ms). */
export function npPosition(n: NowPlaying, at = Date.now()) {
  const base = n.position ?? 0;
  const run = n.device_state === 'playing' && n.sampled_at ? at / 1000 - (n.skew ?? 0) - n.sampled_at : 0;
  return Math.max(0, Math.min(base + Math.max(0, run), n.total_time || Infinity));
}

export const mmss = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${p}` : `${m}:${p}`;
};

export async function npCommand(action: 'play_pause' | 'next' | 'previous' | 'volume_up' | 'volume_down') {
  if (NP_MOCK) return { ok: true };
  const r = await fetch('/api/nowplaying/cmd', { method: 'POST', body: JSON.stringify({ action }) });
  const j = await r.json().catch(() => ({}));
  setTimeout(refreshNowPlaying, 350); // pick up the push update quickly
  return r.ok ? j : { error: j.error ?? `HTTP ${r.status}` };
}

export async function homeCommand(cmd: Record<string, unknown>) {
  const r = await fetch('/api/home/command', { method: 'POST', body: JSON.stringify(cmd) });
  return r.json();
}

// ---------- formatting ----------
export const hm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayName = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'long' });
export const longDate = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function relDay(d: Date, ref = now.value) {
  const a = new Date(d).setHours(0, 0, 0, 0);
  const b = new Date(ref).setHours(0, 0, 0, 0);
  const diff = Math.round((a - b) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return dayName(d);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function until(d: Date, ref = now.value) {
  const m = Math.round((d.getTime() - ref.getTime()) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 && h < 3 ? `in ${h} h ${m % 60} min` : `in ${h} h`;
}

export function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function bytes(n: number, digits = 1) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? digits : 0)} ${u[i]}`;
}

export function upcoming(events: CalEvent[], ref = now.value) {
  return events
    .filter((e) => !e.allDay && new Date(e.end) > ref)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start));
}
