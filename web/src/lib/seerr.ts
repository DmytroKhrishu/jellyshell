// Seerr + downloads client. Everything goes through the page server proxy (web-poc/arr_proxy.py);
// the browser only sends its Jellyfin token, which the server verifies and maps to the Seerr user.
import { auth } from './jellyfin';
import { noPageServer } from './uisource';

export class ProxyError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (noPageServer()) throw new ProxyError(503, 'Requests need your home server'); // bundled: no fetch at all
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
  if (!res.ok) throw new ProxyError(res.status, data?.error || `${res.status} ${path}`);
  return data as T;
}

// ---------------- types ----------------
/** Seerr MediaStatus */
export const MS = { UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIAL: 4, AVAILABLE: 5, BLOCKLISTED: 6, DELETED: 7 } as const;
/** Seerr MediaRequestStatus */
export const RS = { PENDING: 1, APPROVED: 2, DECLINED: 3, FAILED: 4, COMPLETED: 5 } as const;

export interface MediaInfo {
  id?: number;
  status?: number;
  jellyfinMediaId?: string | null;
  requests?: { id: number; status: number; requestedBy?: { id: number; displayName?: string }; seasons?: { seasonNumber: number }[] }[];
  seasons?: { seasonNumber: number; status: number }[];
  downloadStatus?: unknown[];
}

export interface SItem {
  id: number; // tmdb id
  mediaType: 'movie' | 'tv' | 'person' | string;
  title?: string;
  name?: string;
  overview?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string;
  firstAirDate?: string;
  voteAverage?: number;
  mediaInfo?: MediaInfo;
}

export interface SDetail extends SItem {
  genres?: { id: number; name: string }[];
  runtime?: number;
  episodeRunTime?: number[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  seasons?: { seasonNumber: number; episodeCount: number; name: string; airDate?: string | null; posterPath?: string | null }[];
  tagline?: string;
  status?: string;
  contentRatings?: { results?: { iso_3166_1: string; rating: string }[] };
  releases?: { results?: { iso_3166_1: string; release_dates: { certification: string }[] }[] };
  credits?: { cast?: Cast[] };
  relatedVideos?: { site: string; key: string; name: string; type: string; url?: string }[];
  networks?: { id: number; name: string }[];
}

export interface Cast {
  id: number; // tmdb person id
  name: string;
  character?: string;
  profilePath?: string | null;
}

export interface Ratings {
  rt?: { criticsScore?: number; audienceScore?: number; criticsRating?: string };
  imdb?: { criticsScore?: number };
}

export interface ServerOpts {
  id: number;
  name: string;
  isDefault: boolean;
  profiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string; freeSpace?: number }[];
  languageProfiles: { id: number; name: string }[] | null;
  activeProfileId?: number;
  activeDirectory?: string;
  activeLanguageProfileId?: number | null;
  minimumAvailability?: MinAvail;
}
export type MinAvail = 'announced' | 'inCinemas' | 'released';
export const MIN_AVAIL_LABEL: Record<MinAvail, string> = { announced: 'Announced', inCinemas: 'In cinemas', released: 'Released' };

export interface RequestBody {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  seasons?: number[] | 'all';
  // Advanced (Seerr admin / Manage requests / Advanced requests only; the proxy enforces it):
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
  minimumAvailability?: MinAvail;
}

export interface Page<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
}

export interface Me {
  jellyfinUserId: string;
  jellyfinName: string;
  seerrUserId: number | null;
  displayName: string;
  attributed: boolean;
  /** May pick quality profile / release threshold (Seerr admin, Manage requests or Advanced requests). */
  advanced?: boolean;
}

export interface MyRequest {
  id: number;
  status: number;
  createdAt: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  mediaStatus: number;
  jellyfinMediaId?: string | null;
  seasons: number[];
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  year?: string;
}

// ---------------- api ----------------
const enc = encodeURIComponent;
export const discover = {
  trending: () => call<Page<SItem>>('/api/seerr/discover/trending?page=1'),
  movies: () => call<Page<SItem>>('/api/seerr/discover/movies?page=1'),
  tv: () => call<Page<SItem>>('/api/seerr/discover/tv?page=1'),
  upcoming: () => call<Page<SItem>>('/api/seerr/discover/movies/upcoming?page=1'),
};
export const searchTmdb = (q: string, signal?: AbortSignal) => call<Page<SItem>>(`/api/seerr/search?query=${enc(q)}&page=1`, { signal });
export const getDetail = (type: 'movie' | 'tv', id: number) => call<SDetail>(`/api/seerr/${type}/${id}`);
export const me = () => call<Me>('/api/seerr/me');
export const myRequests = () => call<{ user: Me; results: MyRequest[] }>('/api/seerr/myrequests');
export const createRequest = (body: RequestBody) =>
  call<{ request: { id: number; status: number }; attributedTo: string; attributed: boolean; minimumAvailability?: string }>('/api/seerr/request', { body });
export const deleteRequest = (id: number) => call<{ deleted: number }>(`/api/seerr/request/${id}`, { method: 'DELETE' });
export const requestOptions = (type: 'movie' | 'tv') => call<{ advanced: boolean; servers: ServerOpts[] }>(`/api/seerr/reqoptions?type=${type}`);
export const related = (type: 'movie' | 'tv', id: number, kind: 'recommendations' | 'similar') => call<Page<SItem>>(`/api/seerr/${type}/${id}/${kind}?page=1`);
export const ratings = (type: 'movie' | 'tv', id: number): Promise<Ratings> =>
  type === 'movie' ? call<Ratings>(`/api/seerr/movie/${id}/ratingscombined`) : call<Ratings['rt']>(`/api/seerr/tv/${id}/ratings`).then((rt) => ({ rt }));

// ---------------- helpers ----------------
export const tmdbImg = (path: string | null | undefined, size: 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w342') =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

export const titleOf = (it: SItem) => it.title ?? it.name ?? '';
export const yearOf = (it: SItem) => (it.releaseDate || it.firstAirDate || '').slice(0, 4);

export type Avail = 'available' | 'partial' | 'processing' | 'pending' | 'none';
export function availability(mi?: MediaInfo): Avail {
  switch (mi?.status) {
    case MS.AVAILABLE:
      return 'available';
    case MS.PARTIAL:
      return 'partial';
    case MS.PROCESSING:
      return 'processing';
    case MS.PENDING:
      return 'pending';
  }
  return 'none';
}
export const AVAIL_LABEL: Record<Avail, string> = {
  available: 'Available',
  partial: 'Partially available',
  processing: 'Requested',
  pending: 'Pending approval',
  none: 'Not requested',
};

export function requestStatusLabel(r: MyRequest): { label: string; tone: Avail | 'failed' } {
  if (r.status === RS.DECLINED) return { label: 'Declined', tone: 'failed' };
  if (r.status === RS.FAILED) return { label: 'Failed', tone: 'failed' };
  if (r.mediaStatus === MS.AVAILABLE) return { label: 'Available', tone: 'available' };
  if (r.mediaStatus === MS.PARTIAL) return { label: 'Partially available', tone: 'partial' };
  if (r.status === RS.PENDING) return { label: 'Pending approval', tone: 'pending' };
  return { label: 'Requested', tone: 'processing' };
}

// ---------------- downloads ----------------
export interface DlItem {
  id: string;
  kind: 'movie' | 'episode';
  title: string;
  subtitle: string;
  poster: string | null;
  tmdbId?: number;
  status: 'downloading' | 'queued' | 'importing' | 'stalled' | 'failed';
  percent: number;
  size: number;
  sizeLeft: number;
  speed: number;
  eta: number | null;
  quality?: string;
  message?: string;
  /** Set by the proxy when the title already exists in the Jellyfin library. */
  jellyfinId?: string;
  jellyfinSeasonId?: string | null;
}
export interface Recent {
  id: string;
  kind: 'movie' | 'episode';
  title: string;
  subtitle: string;
  poster: string | null;
  date: string;
  quality?: string;
  jellyfinId?: string;
  jellyfinSeasonId?: string | null;
}
export interface Downloads {
  items: DlItem[];
  recent: Recent[];
  errors: string[];
  at: number;
}
export const getDownloads = (demo = false) => call<Downloads>('/api/downloads' + (demo ? '?demo=1' : ''));

// ---------------- release calendar ----------------
export interface CalEvent {
  id: string;
  kind: 'episode' | 'cinema' | 'digital' | 'physical';
  /** Release day "YYYY-MM-DD" (episodes: air time in the server zone; movies: Radarr's date). */
  date: string;
  /** Episodes: exact air time (UTC ISO). Movies: null (date-only). */
  at: string | null;
  title: string;
  subtitle: string;
  /** Episodes airing together (season drops) are one event. */
  count?: number;
  filesHave?: number;
  hasFile: boolean;
  monitored: boolean;
  poster: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  jellyfinId?: string;
  jellyfinSeasonId?: string | null;
}
export interface Calendar {
  events: CalEvent[];
  errors: string[];
  start: string;
  end: string;
}
export const getCalendar = (start: string, end: string, demo = false) =>
  call<Calendar>(`/api/calendar?start=${start}&end=${end}` + (demo ? '&demo=1' : ''));

export function fmtBytes(n: number) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
export function fmtEta(s: number | null | undefined) {
  if (s == null || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.max(1, Math.round(s))}s`;
}
export function fmtAgo(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}
