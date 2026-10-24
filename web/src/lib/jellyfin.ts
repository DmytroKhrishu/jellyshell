// Thin Jellyfin REST client (fetch only). Auth persisted in localStorage.
import { signal } from '@preact/signals';
import { log } from './log';
import { invalidate } from './datasync';
import { BUNDLED_DEFAULT_SERVER, bundledAtBoot } from './uisource';

export const VERSION = '0.2.0';
// Same host the page was served from (LAN IP on the Xbox, tailnet IP / MagicDNS name on a laptop), Jellyfin port.
// Public URL (served under /jellyshell/ by a reverse proxy / tunnel): Jellyfin is the root of the same origin.
// Bundled in the Store package (https://app.jellyshell/): no page host to derive it from, use the build-time default.
// When the page server sets JELLYFIN_PUBLIC_URL, GET api/config returns it as `jellyfinUrl` and it wins (loaded below;
// `export let` is a live binding, so readers after boot see the updated value).
export let DEFAULT_SERVER = bundledAtBoot
  ? BUNDLED_DEFAULT_SERVER
  : location.protocol === 'https:' && /^\/jellyshell(\/|$)/.test(location.pathname)
    ? location.origin
    : /^https?:$/.test(location.protocol) && location.hostname ? `${location.protocol}//${location.hostname}:8096` : 'http://localhost:8096';
/** True once api/config named the Jellyfin server (JELLYFIN_PUBLIC_URL). */
export const serverFromConfig = signal(false);
if (!bundledAtBoot && /^https?:$/.test(location.protocol)) {
  fetch('api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      const u = typeof c?.jellyfinUrl === 'string' ? c.jellyfinUrl.trim().replace(/\/+$/, '') : '';
      if (/^https?:\/\//.test(u)) {
        DEFAULT_SERVER = u;
        serverFromConfig.value = true;
      }
    })
    .catch(() => {});
}
const AUTH_KEY = 'jellyshell.auth.v1';
const DEVICE_KEY = 'jellyshell.deviceId';

export interface Auth {
  server: string;
  token: string;
  userId: string;
  userName: string;
  serverName?: string;
}

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'jellyshell-' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
export const DEVICE_ID = deviceId();
// Shown in Jellyfin's Dashboard → Devices / Sessions.
const UA = navigator.userAgent;
const DEVICE_NAME = (window as any).chrome?.webview || /Xbox/i.test(UA)
  ? 'Xbox Series S'
  : /iPad/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1) ? 'iPad'
  : /iPhone|iPod/.test(UA) ? 'iPhone'
  : /JellyShellTV\//.test(UA) ? 'Android TV'
  : /Android/i.test(UA) ? (/Mobile/i.test(UA) ? 'Android phone' : 'Android tablet')
  : 'Web browser';

function loadAuth(): Auth | null {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    return a && a.token && a.userId ? a : null;
  } catch {
    return null;
  }
}

export const auth = signal<Auth | null>(loadAuth());

export function setAuth(a: Auth | null) {
  auth.value = a;
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  else localStorage.removeItem(AUTH_KEY);
}

export function lastServer() {
  return auth.value?.server || localStorage.getItem('jellyshell.server') || DEFAULT_SERVER;
}

export function authHeader(token?: string) {
  const t = token ?? auth.value?.token;
  return (
    `MediaBrowser Client="JellyShell", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${VERSION}"` +
    (t ? `, Token="${t}"` : '')
  );
}

export class ApiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; server?: string; signal?: AbortSignal } = {}): Promise<T> {
  const server = (opts.server ?? auth.value?.server ?? DEFAULT_SERVER).replace(/\/+$/, '');
  const res = await fetch(server + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      Authorization: authHeader(),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 401 && auth.value && !opts.server) {
    log('api 401 -> signing out', path);
    setAuth(null);
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText} ${path}`);
  if (res.status === 204) return undefined as T;
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

// ---------- types (subset) ----------
export interface UserData {
  PlaybackPositionTicks?: number;
  PlayedPercentage?: number;
  Played?: boolean;
  IsFavorite?: boolean;
  UnplayedItemCount?: number;
}
export interface MediaStream {
  Type: 'Video' | 'Audio' | 'Subtitle' | string;
  Index: number;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  Channels?: number;
  ChannelLayout?: string;
  Width?: number;
  Height?: number;
  VideoRangeType?: string;
  VideoRange?: string;
  RealFrameRate?: number;
  AverageFrameRate?: number;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  Path?: string;
  IsTextSubtitleStream?: boolean;
  DeliveryUrl?: string;
  DeliveryMethod?: string;
  Profile?: string;
}
export interface MediaSource {
  Id: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  MediaStreams: MediaStream[];
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  RunTimeTicks?: number;
  ETag?: string;
}
export interface Item {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  PremiereDate?: string;
  EndDate?: string;
  OfficialRating?: string;
  CommunityRating?: number;
  CriticRating?: number;
  RunTimeTicks?: number;
  Overview?: string;
  Taglines?: string[];
  Genres?: string[];
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ParentLogoItemId?: string;
  ParentLogoImageTag?: string;
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
  SeriesPrimaryImageTag?: string;
  PrimaryImageAspectRatio?: number;
  UserData?: UserData;
  MediaSources?: MediaSource[];
  MediaStreams?: MediaStream[];
  Chapters?: { StartPositionTicks: number; Name?: string }[];
  ChildCount?: number;
  RecursiveItemCount?: number;
  CollectionType?: string;
  People?: { Name: string; Role?: string; Type: string; Id: string; PrimaryImageTag?: string }[];
  Status?: string;
}
export interface ItemsResult {
  Items: Item[];
  TotalRecordCount: number;
}

const FIELDS = 'Overview,PrimaryImageAspectRatio,Genres,Taglines,ProductionYear,ParentId,MediaStreams,MediaSources,Chapters';
const LIST_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview,Genres';
const IMG = 'EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1';

const uid = () => auth.value!.userId;

// ---------- auth ----------
export async function serverInfo(server: string) {
  return api<{ ServerName: string; Version: string; Id: string }>('/System/Info/Public', { server });
}
export async function quickConnectEnabled(server: string) {
  try {
    return await api<boolean>('/QuickConnect/Enabled', { server });
  } catch {
    return false;
  }
}
export async function quickConnectInitiate(server: string) {
  return api<{ Secret: string; Code: string }>('/QuickConnect/Initiate', { server, method: 'POST' });
}
export async function quickConnectState(server: string, secret: string) {
  return api<{ Authenticated: boolean }>(`/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`, { server });
}
interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}
export async function quickConnectAuth(server: string, secret: string) {
  return api<AuthResult>('/Users/AuthenticateWithQuickConnect', { server, body: { Secret: secret } });
}
export async function passwordAuth(server: string, username: string, pw: string) {
  return api<AuthResult>('/Users/AuthenticateByName', { server, body: { Username: username, Pw: pw } });
}
export async function logout() {
  try {
    await api('/Sessions/Logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  setAuth(null);
}

// ---------- browse ----------
export async function views() {
  return api<ItemsResult>(`/UserViews?userId=${uid()}`);
}
export async function resume(limit = 16) {
  return api<ItemsResult>(`/UserItems/Resume?userId=${uid()}&Limit=${limit}&MediaTypes=Video&Fields=${LIST_FIELDS}&${IMG}`);
}
export async function nextUp(limit = 16) {
  return api<ItemsResult>(`/Shows/NextUp?userId=${uid()}&Limit=${limit}&Fields=${LIST_FIELDS}&${IMG}&EnableResumable=false`);
}
export async function latest(includeTypes: string, limit = 20) {
  return api<Item[]>(`/Items/Latest?userId=${uid()}&IncludeItemTypes=${includeTypes}&Limit=${limit}&Fields=${LIST_FIELDS}&${IMG}&GroupItems=true`);
}

export type SortKey = 'SortName' | 'DateCreated' | 'ProductionYear' | 'CommunityRating';
export type WatchedFilter = 'all' | 'unwatched' | 'watched';
export async function library(type: 'Movie' | 'Series', sort: SortKey, watched: WatchedFilter, start = 0, limit = 400) {
  const order = sort === 'SortName' ? 'Ascending' : 'Descending';
  const sortBy = sort === 'SortName' ? 'SortName' : `${sort},SortName`;
  const filt = watched === 'watched' ? '&Filters=IsPlayed' : watched === 'unwatched' ? '&Filters=IsUnplayed' : '';
  return api<ItemsResult>(
    `/Items?userId=${uid()}&IncludeItemTypes=${type}&Recursive=true&SortBy=${sortBy}&SortOrder=${order}${filt}&StartIndex=${start}&Limit=${limit}&Fields=${LIST_FIELDS}&${IMG}`,
  );
}
export async function search(term: string) {
  return api<ItemsResult>(
    `/Items?userId=${uid()}&searchTerm=${encodeURIComponent(term)}&IncludeItemTypes=Movie,Series,Episode&Recursive=true&Limit=40&Fields=${LIST_FIELDS}&${IMG}`,
  );
}
const itemCache = new Map<string, { at: number; it: Item }>();
export async function item(id: string) {
  const it = await api<Item>(`/Items/${id}?userId=${uid()}&Fields=${FIELDS}`);
  itemCache.set(id, { at: Date.now(), it });
  return it;
}
/** Full item fetched in the last `maxAgeMs` (e.g. by the detail page just before Play) — saves a round-trip at startup. */
export function cachedItem(id: string, maxAgeMs = 60_000): Item | null {
  const c = itemCache.get(id);
  return c && Date.now() - c.at < maxAgeMs ? c.it : null;
}
export async function seasons(seriesId: string) {
  return api<ItemsResult>(`/Shows/${seriesId}/Seasons?userId=${uid()}&Fields=${LIST_FIELDS}&${IMG}`);
}
export async function episodes(seriesId: string, seasonId: string) {
  return api<ItemsResult>(`/Shows/${seriesId}/Episodes?userId=${uid()}&seasonId=${seasonId}&Fields=${LIST_FIELDS},MediaStreams&${IMG}`);
}
export async function seriesNextUp(seriesId: string) {
  return api<ItemsResult>(`/Shows/NextUp?userId=${uid()}&seriesId=${seriesId}&Limit=1&Fields=${LIST_FIELDS}&EnableResumable=true`);
}
export async function nextEpisodeAfter(ep: Item): Promise<Item | null> {
  if (!ep.SeriesId) return null;
  const r = await api<ItemsResult>(
    `/Shows/${ep.SeriesId}/Episodes?userId=${uid()}&startItemId=${ep.Id}&Limit=2&Fields=${LIST_FIELDS}&${IMG}`,
  );
  return r.Items.find((i) => i.Id !== ep.Id) ?? null;
}
export async function similar(id: string) {
  return api<ItemsResult>(`/Items/${id}/Similar?userId=${uid()}&Limit=16&Fields=${LIST_FIELDS}&${IMG}`);
}

// ---------- user data ----------
export async function setPlayed(id: string, played: boolean) {
  const r = await api<UserData>(`/UserPlayedItems/${id}?userId=${uid()}`, { method: played ? 'POST' : 'DELETE' });
  invalidate(played ? 'played' : 'unplayed');
  return r;
}
export async function setFavorite(id: string, fav: boolean) {
  const r = await api<UserData>(`/UserFavoriteItems/${id}?userId=${uid()}`, { method: fav ? 'POST' : 'DELETE' });
  invalidate('favorite');
  return r;
}
/** Remove from Continue Watching. Jellyfin 10.11 has no HideFromResume endpoint: clearing the saved position does it
 * (the item keeps its watched state and play count). */
export async function removeFromResume(id: string) {
  const r = await api<UserData>(`/UserItems/${id}/UserData?userId=${uid()}`, { body: { PlaybackPositionTicks: 0 } });
  invalidate('resume-removed');
  return r;
}

// ---------- images ----------
type ImgType = 'Primary' | 'Backdrop' | 'Thumb' | 'Logo';
export function imageUrl(id: string, type: ImgType, opts: { tag?: string; maxWidth?: number; quality?: number; index?: number } = {}) {
  const s = auth.value?.server ?? DEFAULT_SERVER;
  const q = new URLSearchParams();
  if (opts.tag) q.set('tag', opts.tag);
  q.set('maxWidth', String(opts.maxWidth ?? 400));
  q.set('quality', String(opts.quality ?? 85));
  return `${s}/Items/${id}/Images/${type}${opts.index !== undefined ? '/' + opts.index : ''}?${q}`;
}

/** Best poster (2:3). Episodes fall back to the series poster. */
export function posterUrl(it: Item, w = 400) {
  if (it.Type === 'Episode' && it.SeriesId && it.SeriesPrimaryImageTag)
    return imageUrl(it.SeriesId, 'Primary', { tag: it.SeriesPrimaryImageTag, maxWidth: w });
  if (it.ImageTags?.Primary) return imageUrl(it.Id, 'Primary', { tag: it.ImageTags.Primary, maxWidth: w });
  return null;
}
/** Best 16:9 still: episode primary, item thumb, backdrop, parent thumb/backdrop. */
export function thumbUrl(it: Item, w = 640) {
  if (it.Type === 'Episode' && it.ImageTags?.Primary) return imageUrl(it.Id, 'Primary', { tag: it.ImageTags.Primary, maxWidth: w });
  if (it.ImageTags?.Thumb) return imageUrl(it.Id, 'Thumb', { tag: it.ImageTags.Thumb, maxWidth: w });
  if (it.BackdropImageTags?.length) return imageUrl(it.Id, 'Backdrop', { tag: it.BackdropImageTags[0], maxWidth: w });
  if (it.ParentThumbItemId && it.ParentThumbImageTag) return imageUrl(it.ParentThumbItemId, 'Thumb', { tag: it.ParentThumbImageTag, maxWidth: w });
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags?.length)
    return imageUrl(it.ParentBackdropItemId, 'Backdrop', { tag: it.ParentBackdropImageTags[0], maxWidth: w });
  return null;
}
export function backdropUrl(it: Item, w = 1920) {
  if (it.BackdropImageTags?.length) return imageUrl(it.Id, 'Backdrop', { tag: it.BackdropImageTags[0], maxWidth: w, quality: 80 });
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags?.length)
    return imageUrl(it.ParentBackdropItemId, 'Backdrop', { tag: it.ParentBackdropImageTags[0], maxWidth: w, quality: 80 });
  return null;
}
export function logoUrl(it: Item, w = 800) {
  if (it.ImageTags?.Logo) return imageUrl(it.Id, 'Logo', { tag: it.ImageTags.Logo, maxWidth: w, quality: 90 });
  if (it.ParentLogoItemId && it.ParentLogoImageTag) return imageUrl(it.ParentLogoItemId, 'Logo', { tag: it.ParentLogoImageTag, maxWidth: w, quality: 90 });
  return null;
}

// ---------- formatting ----------
export const TICKS_PER_MS = 10_000;
export function fmtRuntime(ticks?: number) {
  if (!ticks) return '';
  const m = Math.round(ticks / TICKS_PER_MS / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
export function fmtClock(ms: number) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
}
export function episodeLabel(it: Item) {
  if (it.Type !== 'Episode') return '';
  const s = it.ParentIndexNumber ?? 0;
  const e = it.IndexNumber ?? 0;
  return `S${s}:E${e}`;
}
export function progressPct(it: Item) {
  const p = it.UserData?.PlayedPercentage;
  if (p) return p;
  const pos = it.UserData?.PlaybackPositionTicks;
  return pos && it.RunTimeTicks ? (pos / it.RunTimeTicks) * 100 : 0;
}
