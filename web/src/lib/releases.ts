// Release dates for Seerr (TMDB) cards and sheets.
// Cards ask lazily (when they scroll into view); asks are batched into one GET api/seerr/dates call per ~80 ms
// (max 40 ids) and cached for the session, so a discover page costs a handful of calls, not one per card.
// The proxy caches each title 6 h and picks one date per release type (Seerr region, then US, else earliest).
import { signal } from '@preact/signals';
import { auth } from './jellyfin';
import { noPageServer } from './uisource';
import { fmtDate, todayYmd } from './clock';
import { log } from './log';

export interface RelDate {
  date: string;
  region: string;
  note: string;
}
export interface MovieDates {
  type: 'movie';
  id: number;
  status?: string;
  releaseDate?: string | null;
  releases: Partial<Record<'premiere' | 'limited' | 'theatrical' | 'digital' | 'physical' | 'tv', RelDate>>;
}
export interface EpDate {
  date: string | null;
  season?: number;
  episode?: number;
  name?: string;
}
export interface TvDates {
  type: 'tv';
  id: number;
  status?: string;
  firstAirDate?: string | null;
  lastAirDate?: string | null;
  nextEpisode?: EpDate | null;
  lastEpisode?: EpDate | null;
  inProduction?: boolean;
}
export type Dates = MovieDates | TvDates;

const cache = new Map<string, Dates | null>(); // null = asked, nothing came back
const queued = new Set<string>();
/** Bumped when new dates land; components read it to re-render. */
export const datesRev = signal(0);
let timer = 0;

export const dateKey = (type: string, id: number) => `${type}:${id}`;

export function peekDates(type: string, id: number): Dates | null | undefined {
  void datesRev.value; // subscribe
  return cache.get(dateKey(type, id));
}

// One shared observer: cards ask for their dates only once they come near the viewport.
let io: IntersectionObserver | null = null;
const onSeen = new WeakMap<Element, () => void>();
/** Runs cb once when el gets near the viewport; returns a cleanup. */
export function whenVisible(el: Element | null, cb: () => void) {
  if (!el) return;
  if (typeof IntersectionObserver === 'undefined') return void cb();
  io ??= new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          onSeen.get(e.target)?.();
          onSeen.delete(e.target);
          io!.unobserve(e.target);
        }
    },
    { rootMargin: '40% 60% 40% 60%' },
  );
  onSeen.set(el, cb);
  io.observe(el);
  return () => {
    onSeen.delete(el);
    io?.unobserve(el);
  };
}

/** Ask for dates (no-op if cached / in flight). */
export function wantDates(type: string, id: number) {
  if (type !== 'movie' && type !== 'tv') return;
  const k = dateKey(type, id);
  if (cache.has(k) || queued.has(k)) return;
  queued.add(k);
  if (!timer) timer = window.setTimeout(flush, 80);
}

async function flush() {
  timer = 0;
  if (noPageServer()) return;
  const keys = [...queued].slice(0, 40);
  keys.forEach((k) => queued.delete(k));
  if (queued.size) timer = window.setTimeout(flush, 80);
  const ids = { movie: [] as string[], tv: [] as string[] };
  for (const k of keys) {
    const [t, id] = k.split(':');
    ids[t as 'movie' | 'tv'].push(id);
  }
  const qs = [ids.movie.length ? 'movie=' + ids.movie.join(',') : '', ids.tv.length ? 'tv=' + ids.tv.join(',') : ''].filter(Boolean).join('&');
  try {
    const a = auth.value;
    const r = await fetch('api/seerr/dates?' + qs, { headers: { 'X-Jellyfin-Token': a?.token ?? '', 'X-Jellyfin-User': a?.userId ?? '' } });
    const data: Record<string, Dates> = r.ok ? await r.json() : {};
    for (const k of keys) cache.set(k, data[k] ?? null);
  } catch (e) {
    log('seerr dates failed', String(e));
    for (const k of keys) cache.set(k, null);
  }
  datesRev.value++;
}

// ---------------- formatting ----------------
const future = (d?: string | null) => !!d && d > todayYmd();
const short = (d: string) => fmtDate(d, 'auto');
const epCode = (e: EpDate) => (e.season != null && e.episode != null ? `S${e.season}E${e.episode}` : '');

function tvStatus(d: TvDates) {
  switch (d.status) {
    case 'Returning Series':
      return 'Returning';
    case 'Ended':
      return 'Ended';
    case 'Canceled':
      return 'Canceled';
    case 'In Production':
    case 'Planned':
    case 'Pilot':
      return 'In production';
  }
  return d.status ?? '';
}

/** Compact line for a card: "In cinemas · Digital Nov 3", "Coming Oct 24, 2026", "Returning · Next ep Oct 24". */
export function cardDates(d: Dates | null | undefined, fallbackYear: string): { text: string; coming: string | null } {
  if (!d) return { text: fallbackYear, coming: null };
  if (d.type === 'tv') {
    if (future(d.firstAirDate)) return { text: `Premieres ${short(d.firstAirDate!)}`, coming: short(d.firstAirDate!) };
    const next = d.nextEpisode?.date && !future(d.nextEpisode.date) ? null : d.nextEpisode;
    if (next?.date) return { text: `${tvStatus(d)} · Next ep ${short(next.date)}`, coming: `Ep ${short(next.date)}` };
    const y0 = (d.firstAirDate ?? '').slice(0, 4);
    const y1 = (d.lastAirDate ?? '').slice(0, 4);
    const span = d.status === 'Ended' || d.status === 'Canceled' ? (y1 && y1 !== y0 ? `${y0}–${y1}` : y0) : y0 ? `${y0}–` : '';
    return { text: [span || fallbackYear, tvStatus(d)].filter(Boolean).join(' · '), coming: null };
  }
  const r = d.releases;
  const cin = r.theatrical ?? r.limited ?? r.premiere;
  const dig = r.digital;
  const first = [cin?.date, dig?.date, r.physical?.date, r.tv?.date, d.releaseDate].filter(Boolean).sort()[0] as string | undefined;
  if (!first || future(first)) {
    const when = (cin && future(cin.date) ? cin : dig) ?? null;
    const day = when?.date ?? first;
    if (!day) return { text: 'Coming soon', coming: 'Soon' };
    return { text: `${when === cin && cin ? 'In cinemas' : when === dig && dig ? 'Digital' : 'Coming'} ${short(day)}`, coming: short(day) };
  }
  const recent = (x?: RelDate) => !!x && !future(x.date) && Date.parse(todayYmd()) - Date.parse(x.date) < 120 * 864e5;
  if (cin && !future(cin.date) && dig && future(dig.date)) return { text: `In cinemas · Digital ${short(dig.date)}`, coming: null };
  if (recent(dig)) return { text: `Digital since ${short(dig!.date)}`, coming: null };
  if (recent(cin) && !dig) return { text: `In cinemas since ${short(cin!.date)}`, coming: null };
  return { text: first.slice(0, 4), coming: null };
}

export interface DateRow {
  label: string;
  value: string;
  sub?: string;
  coming?: boolean;
}

const REL_LABEL: [keyof MovieDates['releases'], string][] = [
  ['premiere', 'Premiere'],
  ['limited', 'Limited release'],
  ['theatrical', 'In cinemas'],
  ['digital', 'Digital'],
  ['physical', 'Blu-ray / DVD'],
  ['tv', 'TV'],
];

/** Full list for the sheet / page. `home` = the region the proxy chose for most dates (shown only when it differs). */
export function dateRows(d: Dates | null | undefined): DateRow[] {
  if (!d) return [];
  if (d.type === 'tv') {
    const rows: DateRow[] = [];
    if (d.status) rows.push({ label: 'Status', value: tvStatus(d) });
    if (d.firstAirDate) rows.push({ label: future(d.firstAirDate) ? 'Premieres' : 'First aired', value: fmtDate(d.firstAirDate), coming: future(d.firstAirDate) });
    if (d.lastEpisode?.date && !future(d.firstAirDate)) rows.push({ label: 'Last episode', value: fmtDate(d.lastEpisode.date), sub: [epCode(d.lastEpisode), d.lastEpisode.name].filter(Boolean).join(' · ') });
    if (d.nextEpisode?.date) rows.push({ label: 'Next episode', value: fmtDate(d.nextEpisode.date), sub: [epCode(d.nextEpisode), d.nextEpisode.name].filter(Boolean).join(' · '), coming: future(d.nextEpisode.date) });
    return rows;
  }
  const count = new Map<string, number>();
  for (const r of Object.values(d.releases)) count.set(r!.region, (count.get(r!.region) ?? 0) + 1);
  const home = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rows: DateRow[] = REL_LABEL.filter(([k]) => d.releases[k]).map(([k, label]) => {
    const r = d.releases[k]!;
    return { label, value: fmtDate(r.date), sub: [r.note, r.region !== home ? r.region : ''].filter(Boolean).join(' · '), coming: future(r.date) };
  });
  if (!rows.length && d.releaseDate) rows.push({ label: future(d.releaseDate) ? 'Coming' : 'Released', value: fmtDate(d.releaseDate), coming: future(d.releaseDate) });
  return rows;
}
