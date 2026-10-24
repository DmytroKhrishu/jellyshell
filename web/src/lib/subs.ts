// Subtitle tools client (Bazarr through the page server, web-poc/subs_proxy.py). Only the Jellyfin token leaves the browser.
import { auth } from './jellyfin';
import { noPageServer } from './uisource';

export class SubsError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (noPageServer()) throw new SubsError(503, 'Subtitle tools need your home server'); // bundled: no fetch at all
  const a = auth.value;
  const res = await fetch(path.replace(/^\//, ''), { // page-relative: works under /jellyshell/ too
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'X-Jellyfin-Token': a?.token ?? '',
      'X-Jellyfin-User': a?.userId ?? '',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const txt = await res.text();
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new SubsError(res.status, data?.error || `${res.status}`);
  return data as T;
}

export interface FileRelease {
  name: string;
  group: string | null;
  source: string | null; // WEB | BluRay | HDTV | DVDRip
  sourceLabel: string | null; // as written in the file name (WEBRip, WEB-DL, …)
  resolution: string | null;
  runtimeSeconds?: number | null;
  fps?: number | null;
}
export interface SubInfo {
  language: string; // 2-letter
  name: string;
  forced: boolean;
  hi: boolean;
  external: boolean;
  path: string | null;
  fileName: string | null;
  jellyfinIndex: number | null;
  ours: boolean; // downloaded through JellyShell (may be deleted here)
  cut?: CutCheck | null;
}
export interface ItemSubs {
  kind: 'episode' | 'movie';
  canManage: boolean;
  file: FileRelease;
  subtitles: SubInfo[];
  missing: string[];
}
export interface Candidate {
  provider: string;
  subtitle: string;
  language: string;
  hi: boolean;
  forced: boolean;
  originalFormat: boolean;
  score: number;
  releases: string[];
  uploader: string | null;
  matches: string[];
  dontMatches: string[];
  groupMatch: boolean;
  sourceMatch: boolean;
  replaces: boolean;
  fps?: number | null;
}
export interface SearchResult {
  file: FileRelease;
  current?: { fileName: string | null; cut: CutCheck | null }[];
  candidates: Candidate[];
  seconds: number;
}

export const itemSubs = (id: string, signal?: AbortSignal) => call<ItemSubs>(`/api/subs/item/${id}`, { signal });
export const searchSubs = (id: string, signal?: AbortSignal) => call<SearchResult>(`/api/subs/search/${id}`, { signal });
export const downloadSub = (id: string, c: Candidate) =>
  call<{ path: string; fileName: string; jellyfinIndex: number | null; replacedExisting: boolean; description?: string }>('/api/subs/download', {
    body: { itemId: id, provider: c.provider, subtitle: c.subtitle, hi: c.hi, forced: c.forced, original_format: c.originalFormat },
  });
export interface CutCheck {
  videoSeconds: number;
  subtitleEndSeconds: number;
  overrunSeconds: number;
  /** The subtitle keeps going well past the end of the video: it was made for a longer cut / another release. */
  likelyOtherCut: boolean;
}
export interface SyncResult {
  fileName: string;
  jellyfinIndex: number;
  offsetSeconds: number | null;
  framerateScale: number | null;
  reference?: string;
  backup?: string | null;
  cut?: CutCheck | null;
}
export const syncSub = (id: string, streamIndex: number, audioOrdinal = 0) =>
  call<SyncResult>('/api/subs/sync', { body: { itemId: id, streamIndex, audioOrdinal } });
export const deleteSub = (id: string, streamIndex: number) => call<{ deleted: string }>(`/api/subs/${id}?index=${streamIndex}`, { method: 'DELETE' });

// ---------------- whole season / series ----------------
export interface SeriesJob {
  id: string;
  seriesId: string;
  seriesName: string;
  season: number | null; // null = whole series
  language: string;
  languageName: string;
  state: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  current: string | null;
  created: { episode: string; fileName: string; provider?: string; score?: number; otherCut?: boolean }[];
  skipped: { episode: string; reason: string }[];
  failed: { episode: string; reason: string }[];
  cancel: boolean;
}
export interface SeriesPlan {
  language: string; // 2-letter, the one the counts are for
  languages: { code2: string; code3: string; name: string }[]; // the series' Bazarr profile (search is limited to these)
  seasons: { season: number; jellyfinId: string | null; episodes: number; missing: number }[];
  episodes: number;
  missing: number;
  job: SeriesJob | null;
}
export const seriesPlan = (seriesId: string, lang: string) => call<SeriesPlan>(`/api/subs/series/${seriesId}?lang=${encodeURIComponent(lang)}`);
export const startSeriesSubs = (seriesId: string, season: number | null, language: string) =>
  call<SeriesJob>('/api/subs/series', { body: { seriesId, season, language } });
export const seriesJob = (id: string) => call<SeriesJob>(`/api/subs/jobs/${id}`);
export const cancelSeriesJob = (id: string) => call<SeriesJob>(`/api/subs/jobs/${id}`, { method: 'DELETE' });

// ---------------- manual timing offset (per item, web renderer only) ----------------
const OFFSET_KEY = 'jellyshell.subOffset.v1';
function offsets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OFFSET_KEY) || '{}');
  } catch {
    return {};
  }
}
/** ms; positive = subtitles appear later, negative = earlier. */
export function subOffset(itemId: string) {
  return offsets()[itemId] ?? 0;
}
export function setSubOffset(itemId: string, ms: number) {
  const o = offsets();
  if (ms) o[itemId] = ms;
  else delete o[itemId];
  localStorage.setItem(OFFSET_KEY, JSON.stringify(o));
}
export function fmtOffset(ms: number) {
  if (!ms) return 'In sync (0 s)';
  const s = (Math.abs(ms) / 1000).toFixed(1).replace(/\.0$/, '');
  return ms < 0 ? `${s} s earlier` : `${s} s later`;
}

export const fmtMin = (s?: number | null) => {
  if (!s) return '';
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const LANG2: Record<string, string> = { en: 'English', uk: 'Ukrainian', ru: 'Russian', cs: 'Czech', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish', ja: 'Japanese', ko: 'Korean', hu: 'Hungarian' };
export const lang2Name = (c: string) => LANG2[c] ?? c.toUpperCase();
/** iso639-2 (settings) -> 2-letter (Bazarr) */
export const LANG3TO2: Record<string, string> = { eng: 'en', ukr: 'uk', rus: 'ru', ces: 'cs', cze: 'cs', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', pol: 'pl', jpn: 'ja', kor: 'ko' };
