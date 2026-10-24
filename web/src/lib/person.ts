// Person (actor / director) data: Jellyfin person + library items, enriched with Seerr (TMDB) bio and filmography.
// Seerr calls go through the page-server proxy (GET-only allow-list in web-poc/arr_proxy.py) and are optional:
// bundled mode / Seerr down still shows the Jellyfin half.
import { api, auth, imageUrl, Item, ItemsResult } from './jellyfin';
import { call as seerrCall, tmdbImg } from './seerr';
import { log } from './log';

export interface SPerson {
  id: number;
  name: string;
  birthday?: string | null;
  deathday?: string | null;
  knownForDepartment?: string;
  alsoKnownAs?: string[];
  biography?: string;
  placeOfBirth?: string | null;
  profilePath?: string | null;
  popularity?: number;
}

export interface SCredit {
  id: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  name?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string;
  firstAirDate?: string;
  character?: string;
  job?: string;
  episodeCount?: number;
  popularity?: number;
  voteCount?: number;
  genreIds?: number[];
}

export interface Person {
  name: string;
  photo: string | null;
  knownFor?: string;
  /** YYYY-MM-DD (TMDB) or a Jellyfin ISO timestamp. */
  birthday?: string | null;
  deathday?: string | null;
  place?: string | null;
  bio?: string;
  aka?: string[];
  jfId?: string;
  tmdbId?: number;
  backdrop?: string | null;
}

/** One filmography entry after merging cast + crew credits of the same title. */
export interface Credit {
  key: string;
  tmdbId: number;
  type: 'movie' | 'tv';
  title: string;
  year: string;
  role: string;
  poster: string | null;
  backdrop: string | null;
  votes: number;
  popularity: number;
  /** Jellyfin item when the title is in the library. */
  lib?: Item;
}

const uid = () => auth.value!.userId;
const LIST = 'Fields=PrimaryImageAspectRatio,ProductionYear,Overview,Genres,ProviderIds&EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1';

// ---------- Jellyfin ----------
export async function jfPerson(id: string) {
  return api<Item & { ProviderIds?: Record<string, string>; ProductionLocations?: string[] }>(
    `/Items/${id}?userId=${uid()}&Fields=Overview,ProviderIds,ProductionLocations`,
  );
}

/** Jellyfin person with this exact name (used when we only know the TMDB id). */
export async function findJfPerson(name: string, tmdbId?: number): Promise<string | undefined> {
  const r = await api<ItemsResult>(`/Persons?userId=${uid()}&searchTerm=${encodeURIComponent(name)}&Limit=10`);
  const same = r.Items.filter((p) => p.Name.toLowerCase() === name.toLowerCase());
  if (!same.length) return undefined;
  if (same.length === 1 || !tmdbId) return same[0].Id;
  for (const p of same) {
    const full = await jfPerson(p.Id).catch(() => null);
    if (full?.ProviderIds?.Tmdb === String(tmdbId)) return p.Id;
  }
  return same[0].Id;
}

export async function personItems(jfId: string) {
  return api<ItemsResult>(
    `/Items?userId=${uid()}&PersonIds=${jfId}&IncludeItemTypes=Movie,Series&Recursive=true&SortBy=ProductionYear,SortName&SortOrder=Descending&${LIST}`,
  );
}

// Library index keyed by "movie:<tmdb>" / "tv:<tmdb>". Jellyfin 10.11 ignores AnyProviderIdEquals, so fetch
// ProviderIds for every movie/series once and match locally (cached a few minutes).
let libIdx: { at: number; user: string; map: Promise<Map<string, Item>> } | null = null;
export function libraryIndex(): Promise<Map<string, Item>> {
  const user = uid();
  if (libIdx && libIdx.user === user && Date.now() - libIdx.at < 5 * 60_000) return libIdx.map;
  const map = api<ItemsResult>(`/Items?userId=${user}&IncludeItemTypes=Movie,Series&Recursive=true&${LIST}`).then((r) => {
    const m = new Map<string, Item>();
    for (const it of r.Items as (Item & { ProviderIds?: Record<string, string> })[]) {
      const t = it.ProviderIds?.Tmdb;
      if (t) m.set(`${it.Type === 'Series' ? 'tv' : 'movie'}:${t}`, it);
    }
    return m;
  });
  libIdx = { at: Date.now(), user, map };
  map.catch(() => (libIdx = null));
  return map;
}

// ---------- Seerr ----------
export const seerrPerson = (id: number) => seerrCall<SPerson>(`/api/seerr/person/${id}`);
export const seerrCredits = (id: number) => seerrCall<{ cast: SCredit[]; crew: SCredit[] }>(`/api/seerr/person/${id}/combined_credits`);

// Talk / news / reality TV appearances drown the real filmography.
const NOISE_GENRES = new Set([10763, 10764, 10767]);

/** Merge cast (+ crew for non-actors) into one entry per title, most notable first. */
export function buildCredits(c: { cast: SCredit[]; crew: SCredit[] }, knownFor: string | undefined, lib: Map<string, Item>): Credit[] {
  const src: SCredit[] = c.cast.map((x) => ({ ...x, job: undefined }));
  if (knownFor && knownFor !== 'Acting') src.push(...c.crew.map((x) => ({ ...x, character: undefined })));
  else src.push(...c.crew.filter((x) => x.job === 'Director').map((x) => ({ ...x, character: undefined })));
  const out = new Map<string, Credit>();
  for (const x of src) {
    if (x.mediaType !== 'movie' && x.mediaType !== 'tv') continue;
    if (x.mediaType === 'tv' && x.genreIds?.some((g) => NOISE_GENRES.has(g))) continue;
    const key = `${x.mediaType}:${x.id}`;
    const role = x.character?.trim() || x.job || '';
    const prev = out.get(key);
    if (prev) {
      if (role && !prev.role.split(' / ').includes(role)) prev.role = prev.role ? `${prev.role} / ${role}` : role;
      continue;
    }
    out.set(key, {
      key,
      tmdbId: x.id,
      type: x.mediaType,
      title: x.title ?? x.name ?? '',
      year: (x.releaseDate || x.firstAirDate || '').slice(0, 4),
      role,
      poster: tmdbImg(x.posterPath),
      backdrop: tmdbImg(x.backdropPath, 'w1280'),
      votes: x.voteCount ?? 0,
      popularity: x.popularity ?? 0,
      lib: lib.get(key),
    });
  }
  return [...out.values()].sort((a, b) => b.votes - a.votes || b.popularity - a.popularity);
}

// ---------- the whole page ----------
export interface PersonPage {
  person: Person;
  library: Item[];
  movies: Credit[];
  shows: Credit[];
  seerrError?: string;
}

export async function loadPerson(jfId?: string, tmdbId?: number): Promise<PersonPage> {
  const jf = jfId ? await jfPerson(jfId) : null;
  const tmdb = tmdbId ?? (jf?.ProviderIds?.Tmdb ? Number(jf.ProviderIds.Tmdb) : undefined);
  let seerrError: string | undefined;
  const soft = <T>(p: Promise<T>) =>
    p.catch((e) => {
      seerrError = String(e?.message ?? e);
      log('person: seerr failed', seerrError);
      return null;
    });
  const [sp, sc, lib] = await Promise.all([
    tmdb ? soft(seerrPerson(tmdb)) : Promise.resolve(null),
    tmdb ? soft(seerrCredits(tmdb)) : Promise.resolve(null),
    libraryIndex().catch(() => new Map<string, Item>()),
  ] as const);
  if (!jf && !sp) throw new Error(seerrError ?? 'Person not found');
  // Only a TMDB id (e.g. from a Seerr cast list): look the person up in Jellyfin by name.
  const realJf = jfId ?? (sp ? await findJfPerson(sp.name, tmdb).catch(() => undefined) : undefined);
  const items = realJf ? (await personItems(realJf).catch(() => null))?.Items ?? [] : [];

  const credits = sc ? buildCredits(sc, sp?.knownForDepartment, lib) : [];
  const movies = credits.filter((c) => c.type === 'movie').slice(0, 40);
  const shows = credits.filter((c) => c.type === 'tv').slice(0, 30);
  const jfPhoto = jf?.ImageTags?.Primary ? imageUrl(jf.Id, 'Primary', { tag: jf.ImageTags.Primary, maxWidth: 500 }) : null;
  // Backdrop: his most notable title that's in the library (credits are sorted by TMDB votes), else any library item.
  const bd = credits.map((c) => c.lib).find((i) => i?.BackdropImageTags?.length) ?? items.find((i) => i.BackdropImageTags?.length);
  const person: Person = {
    name: sp?.name ?? jf!.Name,
    photo: jfPhoto ?? tmdbImg(sp?.profilePath, 'w500'),
    knownFor: sp?.knownForDepartment,
    birthday: sp?.birthday ?? jf?.PremiereDate ?? null,
    deathday: sp?.deathday ?? jf?.EndDate ?? null,
    place: sp?.placeOfBirth ?? jf?.ProductionLocations?.[0] ?? null,
    // Seerr's biography is the full TMDB text; Jellyfin's Overview is the same source but can be stale or empty.
    bio: (sp?.biography && sp.biography.length >= (jf?.Overview?.length ?? 0) ? sp.biography : jf?.Overview) || sp?.biography || undefined,
    aka: sp?.alsoKnownAs,
    jfId: realJf,
    tmdbId: tmdb,
    backdrop: bd ? imageUrl(bd.Id, 'Backdrop', { tag: bd.BackdropImageTags![0], maxWidth: 1920, quality: 80 }) : (credits.find((c) => c.backdrop)?.backdrop ?? null),
  };
  return { person, library: items, movies, shows, seerrError: sp && sc ? undefined : seerrError };
}
