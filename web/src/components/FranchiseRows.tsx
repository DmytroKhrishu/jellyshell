// Seerr-backed rows for library detail pages: "From the Same World" (franchise: collection parts + spin-offs across
// movie <-> TV) and the TMDB tail of "More Like This". Both degrade to nothing (library-only page) without Seerr.
import '../styles/requests.css';
import { useEffect, useState } from 'preact/hooks';
import { Card, Row } from './Card';
import { Item, ItemsResult } from '../lib/jellyfin';
import { openItem } from '../lib/actions';
import { libraryIndex } from '../lib/person';
import { franchise, recommendations, seerrRows, tmdbKey } from '../lib/franchise';
import { MS, SItem } from '../lib/seerr';
import { SCard } from '../pages/Requests';
import { openTmdb } from '../pages/Tmdb';

export const SAME_WORLD = 'From the Same World';

interface TmdbExtras {
  world: SItem[];
  recs: SItem[];
  lib: Map<string, Item>;
  /** Arrived after the row was already shown from the library alone: append only, never reorder under focus. */
  late?: boolean;
}

/** How long "More Like This" waits for Seerr before showing the library part alone. */
const HOLD_MS = 4000;

/** Franchise + recommendations + library index for a TMDB title, resolved together. `x` = null while loading or when
 *  Seerr rows are off; `ready` = the More Like This row may render (data in, Seerr off, or HOLD_MS passed). */
export function useTmdbExtras(type: 'movie' | 'tv', id: number | null): { x: TmdbExtras | null; ready: boolean } {
  const on = !!id && seerrRows();
  const [x, setX] = useState<TmdbExtras | null>(null);
  const [held, setHeld] = useState(on);
  useEffect(() => {
    setX(null);
    setHeld(on);
    if (!on || !id) return;
    let live = true;
    let late = false;
    const t = setTimeout(() => ((late = true), live && setHeld(false)), HOLD_MS);
    Promise.all([franchise(type, id), recommendations(type, id), libraryIndex().catch(() => new Map<string, Item>())]).then(([world, recs, lib]) => {
      clearTimeout(t);
      if (live) setX({ world, recs, lib, late }), setHeld(false);
    });
    return () => (clearTimeout(t), void (live = false));
  }, [type, id, on]);
  return { x, ready: !held };
}

/** Library copy wins: open the item page; else the TMDB page (which itself re-checks Seerr's availability). */
function openSItem(it: SItem, lib: Map<string, Item>) {
  const li = lib.get(tmdbKey(it));
  if (li) openItem(li);
  else openTmdb(it);
}

/** In the library but Seerr doesn't know (or is stale): show it as available so the chip matches what A does. */
function withLib(it: SItem, lib: Map<string, Item>): SItem {
  const st = it.mediaInfo?.status;
  return lib.has(tmdbKey(it)) && st !== MS.AVAILABLE && st !== MS.PARTIAL ? { ...it, mediaInfo: { ...it.mediaInfo, status: MS.AVAILABLE } } : it;
}

export function SameWorldRow({ x, gid }: { x: TmdbExtras | null; gid: string }) {
  if (!x?.world.length) return null;
  return (
    <Row title={SAME_WORLD} id={'world-' + gid} lockEnds>
      {x.world.map((it) => (
        <SCard key={tmdbKey(it)} it={withLib(it, x.lib)} fkey={`world-${it.mediaType}-${it.id}`} onSelect={() => openSItem(it, x.lib)} onFocus={() => {}} />
      ))}
    </Row>
  );
}

/** Library first, then TMDB: library titles TMDB recommends (Iron Man -> Iron Man 2, The Avengers), then Jellyfin
 *  "Similar" (genre/tag overlap, order varies per call), then TMDB recommendations not in the library.
 *  Titles already in "From the Same World" are left out. The rest only appends once Seerr answers, so focus never jumps
 *  off a card that's already there: the row waits up to HOLD_MS for Seerr, and later data only appends. */
export function MoreLikeThis({ it, sim, x, ready }: { it: Item; sim: ItemsResult | undefined; x: TmdbExtras | null; ready: boolean }) {
  if (!ready) return null;
  const simItems = sim?.Items ?? [];
  const seen = new Set<string>([it.Id]);
  const world = new Set((x?.world ?? []).map(tmdbKey));
  // Library copies of "From the Same World" titles (Iron Man 3 on Iron Man) stay out of Jellyfin's Similar part too.
  for (const w of x?.world ?? []) {
    const li = x!.lib.get(tmdbKey(w));
    if (li) seen.add(li.Id);
  }
  const libRecs: Item[] = [];
  const tmdbRecs: SItem[] = [];
  for (const r of x?.recs ?? []) {
    const k = tmdbKey(r);
    if (world.has(k)) continue;
    const li = x!.lib.get(k);
    if (li) {
      if (!seen.has(li.Id)) libRecs.push(li), seen.add(li.Id);
    } else if (tmdbRecs.length < 16) tmdbRecs.push(r);
  }
  const restSim = simItems.filter((s) => !seen.has(s.Id));
  const libCards = x?.late ? [...simItems, ...libRecs.filter((l) => !simItems.some((s) => s.Id === l.Id))] : [...libRecs, ...restSim];
  if (!libCards.length && !tmdbRecs.length) return null;
  return (
    <Row title="More Like This" id={'sim-' + it.Id} lockEnds>
      {libCards.map((s) => (
        <Card key={s.Id} item={s} kind="poster" fkey={'sim-' + s.Id} onSelect={(i) => openItem(i)} />
      ))}
      {tmdbRecs.map((r) => (
        <SCard key={tmdbKey(r)} it={r} fkey={`sim-${r.mediaType}-${r.id}`} onSelect={() => openTmdb(r)} onFocus={() => {}} />
      ))}
    </Row>
  );
}
