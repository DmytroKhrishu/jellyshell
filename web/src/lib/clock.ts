// Wall-clock formatting in the household's time zone.
// The Xbox WebView2 reports the console's zone (US Pacific on a retail console), so every clock and
// "Ends at" goes through here: Settings → Time zone = Auto (the page server's zone from /api/config) or a fixed IANA zone.
// The server epoch also corrects a skewed client clock (only when it's off by more than a minute).
import { signal, computed } from '@preact/signals';
import { settings } from './settings';
import { log } from './log';
import { noPageServer } from './uisource';

export const serverTz = signal<string | null>(null);
/** server epoch - client epoch, ms (0 unless the client clock is clearly wrong). */
const skewMs = signal(0);

export const clientTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export const activeTz = computed(() => {
  const pick = settings.value.timeZone;
  if (pick && pick !== 'auto' && validTz(pick)) return pick;
  return serverTz.value ?? clientTz;
});

export function validTz(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function loadServerClock() {
  if (noPageServer()) return; // bundled: no api/config, the device zone / Settings → Time zone apply
  try {
    const t0 = Date.now();
    const r = await fetch('api/config', { cache: 'no-store' });
    const c = await r.json();
    const t1 = Date.now();
    if (c?.timeZone && validTz(c.timeZone)) serverTz.value = c.timeZone;
    if (typeof c?.serverTimeMs === 'number') {
      const d = c.serverTimeMs - (t0 + t1) / 2;
      skewMs.value = Math.abs(d) > 60_000 ? d : 0;
    }
    log('clock', { serverTz: serverTz.value, clientTz, skewS: Math.round(skewMs.value / 1000), offsetMin: new Date().getTimezoneOffset() });
  } catch (e) {
    log('clock config failed', String(e));
  }
}

/** Corrected "now" (epoch ms). */
export const nowMs = () => Date.now() + skewMs.value;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  const h12 = settings.value.clock === '12h';
  const key = tz + (h12 ? '|12' : '|24');
  let f = fmtCache.get(key);
  if (!f) {
    // Settings → Clock: 24-hour "19:05" or 12-hour "7:05 PM" (the console locale would otherwise decide).
    f = h12
      ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })
      : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
    fmtCache.set(key, f);
  }
  return f;
}

/** "19:05" / "7:05 PM" (Settings → Clock) in the active zone. */
export function fmtTime(ms: number = nowMs()) {
  return fmt(activeTz.value).format(new Date(ms));
}
export const fmtTimeIn = (tz: string, ms: number = nowMs()) => fmt(tz).format(new Date(ms));

/** Clock time when `remainingMs` from now has elapsed. */
export const endsAt = (remainingMs: number) => fmtTime(nowMs() + remainingMs);

// ---- calendar days (release calendar): "YYYY-MM-DD" keys and labels in the active zone ----
const dayKeyCache = new Map<string, Intl.DateTimeFormat>();
/** Calendar day of `ms` in the active zone as "YYYY-MM-DD". */
export function dayKey(ms: number = nowMs(), tz: string = activeTz.value) {
  let f = dayKeyCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz });
    dayKeyCache.set(tz, f);
  }
  return f.format(new Date(ms)); // en-CA = ISO order
}
/** Shift a "YYYY-MM-DD" key by `n` days (pure date math, no zone involved). */
export function addDays(key: string, n: number) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** "Wednesday 21 Oct" for a "YYYY-MM-DD" key (the key already is a household-zone day, so format it as UTC). */
export const fmtDayDate = (key: string) => dayLabelFmt.format(new Date(key + 'T00:00:00Z')).replace(',', '');
/** "Today" / "Tomorrow" / "Yesterday", else null, for a "YYYY-MM-DD" key (relative to the active zone's today). */
export function relDay(key: string) {
  const today = dayKey();
  if (key === today) return 'Today';
  if (key === addDays(today, 1)) return 'Tomorrow';
  if (key === addDays(today, -1)) return 'Yesterday';
  return null;
}

// Calendar dates ("2026-10-24" from TMDB/Seerr) are zone-less days: format them in UTC so they never shift a day.
const dateFmts = new Map<string, Intl.DateTimeFormat>();
function dateFmt(withYear: boolean) {
  const k = withYear ? 'y' : 'n';
  let f = dateFmts.get(k);
  if (!f) dateFmts.set(k, (f = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })));
  return f;
}
/** Today in the active zone as "YYYY-MM-DD". */
export function todayYmd() {
  const p = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: activeTz.value }).formatToParts(new Date(nowMs()));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/** "Oct 24, 2026"; year: 'auto' drops it when the date is in the current year ("Oct 24"). */
export function fmtDate(ymd: string, year: boolean | 'auto' = true) {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const withYear = year === 'auto' ? String(y) !== todayYmd().slice(0, 4) : year;
  return dateFmt(withYear).format(new Date(Date.UTC(y, m - 1, d)));
}

export const TIME_ZONES: [string, string][] = [
  ['Europe/Prague', 'Prague'],
  ['Europe/Kyiv', 'Kyiv'],
  ['Europe/London', 'London'],
  ['Europe/Berlin', 'Berlin'],
  ['Europe/Warsaw', 'Warsaw'],
  ['Europe/Lisbon', 'Lisbon'],
  ['America/New_York', 'New York'],
  ['America/Chicago', 'Chicago'],
  ['America/Denver', 'Denver'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
  ['UTC', 'UTC'],
];
export const tzLabel = (tz: string) => TIME_ZONES.find(([z]) => z === tz)?.[1] ?? tz.replace(/^.*\//, '').replace(/_/g, ' ');

// Calendar dates (birthdays, release dates): a date has no zone, so format it in UTC from Y-M-D.
// Jellyfin stores them as local midnight converted to UTC ("1937-05-31T23:00:00Z" = 1 June), so round to the nearest day.
const longDateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export function dateParts(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const t = Date.parse(s);
  if (isNaN(t)) return null;
  const d = new Date(t + 12 * 3600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
/** "1 June 1937" */
export const fmtLongDate = (s: string | null | undefined) => {
  const d = dateParts(s);
  return d ? longDateFmt.format(d) : '';
};
/** Whole years between two calendar dates (`to` defaults to today in the active zone). */
export function yearsBetween(from: string | null | undefined, to?: string | null): number | null {
  const a = dateParts(from);
  const b = to ? dateParts(to) : dateParts(new Intl.DateTimeFormat('en-CA', { timeZone: activeTz.value }).format(new Date(nowMs())));
  if (!a || !b) return null;
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) y--;
  return y;
}
