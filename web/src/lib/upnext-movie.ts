// Movies: "More Like This" shelf at the end credits (components/CreditsShelf.tsx). Two jobs here:
//  1. creditsTiming(): WHEN the credits start, from Intro Skipper's Outro segment / a "Credits" chapter / a fallback.
//  2. relatedForPlayer(): WHAT to offer: the next/earlier parts of the same collection first, then Jellyfin's Similar.
// One entry point per job so other sources (TMDB franchise / spin-offs) can be merged into relatedForPlayer later.
//
// Trigger rule, measured on this library (63 movies, 2026-10-29):
//  - 56 have an Outro. 47 of them are real credit blocks: start at 89–99 % of the runtime and are 143–807 s long (median ~7 min).
//    The other 9 are last-card detections of 16–77 s (Iron Man 1/2/3, Se7en, Thor: Ragnarok, Coraline, Cars, Cars 2, EuroTrip)
//    whose real credits start minutes earlier. MIN_CREDITS_MS = 120 s splits the two groups with a clear gap (77 s vs 143 s).
//  - 11 have a "Credits"/"End Credits" chapter; every one matches its Outro start to the second, and Ted also has an
//    "Opening Credits" chapter at 8 % (excluded by name and by the MIN_FRAC position rule). No tiny-Outro movie has one,
//    so the chapter is a second source, not a rescue.
//  - No usable Outro or chapter (7 without an Outro + the 9 tiny ones = 16 films): FALLBACK_MS = 150 s before the end. 46 of the
//    47 real credit blocks are at least that long (only Once Upon a Time in Hollywood's 143 s, and its credits + scene run 302 s), so
//    the fallback lands inside the credits instead of on the last scene, at the cost of showing up a few minutes late.
//  - A post-credits scene (Outro ends > TAIL_MS before the file end, or a chapter follows the credits chapter: OUATIH's
//    158 s "Red Apple Cigarettes" stinger) hides the shelf when the scene starts, so it never covers it.
// Times are file positions: compare against RunTimeTicks, not the player's duration (HLS transcodes report ~20 s more).
import { Item, ItemsResult, TICKS_PER_MS, api, auth } from './jellyfin';
import { Segment } from './playback';
import { log } from './log';
import { SItem } from './seerr';
import { franchise, seerrRows, tmdbKey } from './franchise';
import { libraryIndex } from './person';

const MIN_CREDITS_MS = 120_000;
const MIN_FRAC = 0.85;
const FALLBACK_MS = 150_000;
const TAIL_MS = 20_000;
/** Shorter than this isn't a movie with credits worth a shelf (shorts, trailers). */
const MIN_RUNTIME_MS = 20 * 60_000;

export interface CreditsTiming {
  /** Position where the shelf comes up. */
  at: number;
  /** Position where it goes away again (a post-credits scene starts), or null = stays until the file ends. */
  until: number | null;
  source: 'outro' | 'chapter' | 'fallback';
}

const CREDITS_CH = /\bcredits?\b/i;
const NOT_END_CH = /\b(opening|main|title|start)\b/i;

export function creditsTiming(item: Item | null, segments: Segment[], runtimeMs: number): CreditsTiming | null {
  if (!item || item.Type !== 'Movie' || runtimeMs < MIN_RUNTIME_MS) return null;
  const cands: CreditsTiming[] = [];
  const o = segments.find((s) => s.Type === 'Outro');
  if (o) {
    const s = o.StartTicks / TICKS_PER_MS;
    const e = o.EndTicks / TICKS_PER_MS;
    if (s >= runtimeMs * MIN_FRAC && e - s >= MIN_CREDITS_MS) cands.push({ at: s, until: runtimeMs - e > TAIL_MS ? e : null, source: 'outro' });
  }
  const ch = item.Chapters ?? [];
  const ci = ch.findIndex((c) => CREDITS_CH.test(c.Name ?? '') && !NOT_END_CH.test(c.Name ?? '') && c.StartPositionTicks / TICKS_PER_MS >= runtimeMs * MIN_FRAC);
  if (ci >= 0) {
    const nextCh = ch[ci + 1]?.StartPositionTicks;
    const after = nextCh !== undefined ? nextCh / TICKS_PER_MS : null;
    cands.push({ at: ch[ci].StartPositionTicks / TICKS_PER_MS, until: after !== null && runtimeMs - after > TAIL_MS ? after : null, source: 'chapter' });
  }
  if (cands.length) {
    // Earliest credible start wins; keep any post-credits boundary either source found.
    cands.sort((a, b) => a.at - b.at);
    const until = cands.map((c) => c.until).find((u) => u !== null && u > cands[0].at) ?? null;
    return { ...cands[0], until };
  }
  return { at: runtimeMs - FALLBACK_MS, until: null, source: 'fallback' };
}

// ---------- related titles ----------
export interface ShelfItem {
  /** Stable key (Jellyfin id, or "tmdb-<type>:<id>" for titles not in the library). */
  key: string;
  /** Library item; absent for a TMDB-only franchise title (then `tmdb` is set and A opens its TMDB page). */
  item?: Item;
  tmdb?: SItem;
  /** Short card subtitle ("Next part · 2013"); undefined = the card's default (year). */
  note?: string;
  why: 'collection-next' | 'collection-prev' | 'world' | 'similar';
}

const uid = () => auth.value!.userId;
const LIST = 'Fields=PrimaryImageAspectRatio,ProductionYear,Overview,Genres,ProviderIds,PremiereDate&EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1';
const TTL = 10 * 60_000;
let moviesCache: { at: number; p: Promise<Item[]> } | null = null;
let boxCache: { at: number; p: Promise<{ box: Item; ids: Set<string> }[]> } | null = null;
const MAX_BOXSETS = 40;

/** Every library movie with ProviderIds (one call, cached): TMDB collection siblings without a BoxSet. */
function movieIndex(): Promise<Item[]> {
  if (!moviesCache || Date.now() - moviesCache.at > TTL) {
    const p = api<ItemsResult>(`/Items?userId=${uid()}&IncludeItemTypes=Movie&Recursive=true&${LIST}`).then((r) => r.Items);
    moviesCache = { at: Date.now(), p };
    p.catch(() => (moviesCache = null));
  }
  return moviesCache.p;
}

/** Jellyfin collections (BoxSets) with their member ids. Skipped for very large collection sets (one call each). */
function boxSets() {
  if (!boxCache || Date.now() - boxCache.at > TTL) {
    const p = api<ItemsResult>(`/Items?userId=${uid()}&IncludeItemTypes=BoxSet&Recursive=true&Limit=${MAX_BOXSETS + 1}`).then(async (r) => {
      if (!r.Items.length || r.TotalRecordCount > MAX_BOXSETS) return [];
      return Promise.all(
        r.Items.map(async (box) => {
          const kids = await api<ItemsResult>(`/Items?userId=${uid()}&ParentId=${box.Id}&Fields=ProviderIds`).catch(() => ({ Items: [] as Item[] }) as ItemsResult);
          return { box, ids: new Set(kids.Items.map((k) => k.Id)) };
        }),
      );
    });
    boxCache = { at: Date.now(), p };
    p.catch(() => (boxCache = null));
  }
  return boxCache.p;
}

const released = (it: Item) => (it.PremiereDate ? Date.parse(it.PremiereDate) : it.ProductionYear ? Date.UTC(it.ProductionYear, 6, 1) : 0);
const unwatched = (it: Item) => !it.UserData?.Played;
const tmdbColl = (it?: Item) => (it as (Item & { ProviderIds?: Record<string, string> }) | undefined)?.ProviderIds?.TmdbCollection;

/** The parts of the current movie's collection (BoxSet, else TMDB collection id), in release order, current included. */
async function collectionParts(item: Item): Promise<Item[]> {
  const movies = await movieIndex().catch(() => [] as Item[]);
  const self = movies.find((m) => m.Id === item.Id);
  const boxes = await boxSets().catch(() => []);
  const box = boxes.find((b) => b.ids.has(item.Id));
  let parts: Item[] = [];
  if (box) parts = movies.filter((m) => box.ids.has(m.Id));
  const coll = tmdbColl(self);
  if (parts.length < 2 && coll) parts = movies.filter((m) => tmdbColl(m) === coll);
  if (parts.length < 2) return [];
  return parts.sort((a, b) => released(a) - released(b) || a.Name.localeCompare(b.Name));
}

/** Same-world titles (web-poc/franchise.py: TMDB collection + cross-type spin-offs, e.g. a movie's TV show), split into
 *  library items and TMDB-only ones. [] without Seerr; never throws. */
async function worldFor(item: Item): Promise<{ lib: Item[]; ext: SItem[] }> {
  if (!seerrRows()) return { lib: [], ext: [] };
  // The player's item is fetched without ProviderIds: take them from the cached movie index.
  type P = Item & { ProviderIds?: Record<string, string> };
  const self = ((item as P).ProviderIds ? item : (await movieIndex().catch(() => [] as Item[])).find((m) => m.Id === item.Id)) as P | undefined;
  const tmdb = Number(self?.ProviderIds?.Tmdb);
  if (!tmdb) return { lib: [], ext: [] };
  const [world, idx] = await Promise.all([franchise('movie', tmdb), libraryIndex().catch(() => new Map<string, Item>())]);
  const lib: Item[] = [];
  const ext: SItem[] = [];
  for (const w of world) {
    const li = idx.get(tmdbKey(w));
    if (li) lib.push(li);
    else ext.push(w);
  }
  return { lib, ext };
}

const WORLD_EXT_MAX = 6;

/** What to offer at the end credits: next parts, same-world titles (library, then up to 6 from TMDB), unwatched earlier
 *  parts, similar (unwatched first), watched leftovers. */
export async function relatedForPlayer(item: Item, max = 16): Promise<ShelfItem[]> {
  const [parts, sim, world] = await Promise.all([
    collectionParts(item).catch(() => [] as Item[]),
    api<ItemsResult>(`/Items/${item.Id}/Similar?userId=${uid()}&Limit=24&${LIST}`).then((r) => r.Items).catch(() => [] as Item[]),
    worldFor(item).catch(() => ({ lib: [] as Item[], ext: [] as SItem[] })),
  ]);
  const i = parts.findIndex((p) => p.Id === item.Id);
  const after = i >= 0 ? parts.slice(i + 1) : [];
  const before = i >= 0 ? parts.slice(0, i) : [];
  const yr = (it: Item) => (it.ProductionYear ? ' · ' + it.ProductionYear : '');
  const out: ShelfItem[] = [];
  const seen = new Set<string>([item.Id]);
  const add = (it: Item, why: ShelfItem['why'], note?: string) => {
    if (seen.has(it.Id) || out.length >= max) return;
    seen.add(it.Id);
    out.push({ key: it.Id, item: it, why, note });
  };
  const addExt = (t: SItem) => {
    const k = 'tmdb-' + tmdbKey(t);
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    const y = (t.releaseDate || t.firstAirDate || '').slice(0, 4);
    const label = t.mediaType === 'tv' ? 'Series' : 'Movie';
    out.push({ key: k, tmdb: t, why: 'world', note: label + (y && y !== '9999' ? ' · ' + y : '') });
  };
  after.forEach((it, k) => add(it, 'collection-next', (k === 0 ? 'Next part' : 'Later part') + yr(it)));
  // Same world (spin-off shows, specials): library copies first, then a few TMDB-only titles (open their TMDB page).
  world.lib.filter((it) => it.Id !== item.Id).forEach((it) => add(it, 'world', (it.Type === 'Series' ? 'Series' : 'Same world') + yr(it)));
  world.ext.slice(0, WORLD_EXT_MAX).forEach(addExt);
  before.filter(unwatched).forEach((it) => add(it, 'collection-prev', 'Earlier part' + yr(it)));
  // Similar: Jellyfin's order (best match first) with unwatched titles ahead of watched ones.
  sim.filter(unwatched).forEach((it) => add(it, 'similar'));
  before.filter((it) => !unwatched(it)).forEach((it) => add(it, 'collection-prev', 'Earlier part' + yr(it)));
  sim.filter((it) => !unwatched(it)).forEach((it) => add(it, 'similar'));
  log('credits shelf: related', { item: item.Name, parts: parts.length, next: after.length, similar: sim.length, world: world.lib.length + '+' + world.ext.length, shown: out.length });
  return out;
}
