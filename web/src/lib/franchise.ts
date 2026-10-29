// "From the Same World" (franchise: collection parts + cross-type spin-offs) and the TMDB half of "More Like This".
// Data comes from the page-server proxy (web-poc/franchise.py, GET api/seerr/franchise, cached 6 h there); everything
// here is optional: no page server / no Seerr / Seerr down = the rows simply don't render.
import { caps } from './caps';
import { noPageServer } from './uisource';
import { call, related, SItem } from './seerr';
import { log } from './log';

/** Seerr-backed rows may be shown (bundled mode, servers without Seerr and public users without a Seerr account: no). */
export function seerrRows(): boolean {
  if (noPageServer()) return false;
  const c = caps.value;
  return !c || (c.seerr !== false && c.requests !== false);
}

const cache = new Map<string, Promise<SItem[]>>();

/** Same-franchise titles of a TMDB movie/show (never throws: [] on any failure). */
export function franchise(type: 'movie' | 'tv', id: number): Promise<SItem[]> {
  const k = `${type}:${id}`;
  let p = cache.get(k);
  if (!p) {
    p = call<{ results: SItem[] }>(`/api/seerr/franchise?type=${type}&id=${id}`).then(
      (r) => r.results ?? [],
      (e) => (log('franchise failed', k, String(e?.message ?? e)), cache.delete(k), []),
    );
    if (cache.size > 200) cache.clear();
    cache.set(k, p);
  }
  return p;
}

/** TMDB recommendations as movie/tv items (Seerr's `similar` is noise: never used for More Like This). */
export function recommendations(type: 'movie' | 'tv', id: number): Promise<SItem[]> {
  return related(type, id, 'recommendations').then(
    (r) => (r.results ?? []).filter((x) => !x.mediaType || x.mediaType === 'movie' || x.mediaType === 'tv').map((x) => ({ ...x, mediaType: x.mediaType || type })),
    (e) => (log('recommendations failed', type, id, String(e?.message ?? e)), []),
  );
}

export const tmdbKey = (it: { mediaType: string; id: number }) => `${it.mediaType}:${it.id}`;
