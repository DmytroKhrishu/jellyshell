// Auto-skip intros ("watch it once per show") + recaps when binge-watching, and the Next Episode timing rules.
//
// Settings → Skip intros (settings.skipIntros):
//  - 'ask'    : never auto-skip; the Skip Intro / Recap button only (the old behaviour).
//  - 'seen'   : (default) a series' intro plays normally until it has been watched (or skipped by hand) once; after that it is
//               skipped automatically in every episode. Memory is per user + SeriesId in localStorage `jellyshell.introSeen.<uid>`.
//               Recaps ("Previously on") differ per episode, so "seen once" doesn't apply: they are skipped only when you are
//               bingeing (the previous episode of the same series finished in this app < BINGE_MS ago), else the button stays.
//  - 'always' : skip every Intro and Recap, movies included.
// Movies only auto-skip with 'always'. Previews (end-of-episode "next time") always stay a button.
import { Item, TICKS_PER_MS, auth } from './jellyfin';
import { settings } from './settings';
import { Segment } from './playback';
import { log } from './log';

const BINGE_MS = 30 * 60_000;
/** Detected intros/recaps longer than this are treated as bogus (Intro Skipper max is 120 s here). */
const MAX_SKIP_MS = 3 * 60_000;

const key = () => 'jellyshell.introSeen.' + (auth.value?.userId ?? 'anon');
function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key()) || '{}') || {};
  } catch {
    return {};
  }
}

export function introSeen(seriesId?: string) {
  return !!seriesId && !!load()[seriesId];
}

export function markIntroSeen(item: Item | null, how: 'watched' | 'skipped') {
  const sid = item?.Type === 'Episode' ? item.SeriesId : undefined;
  if (!sid || introSeen(sid)) return;
  const m = load();
  m[sid] = Date.now();
  localStorage.setItem(key(), JSON.stringify(m));
  log('intro seen', { series: item?.SeriesName, how });
}

// ---- binge detection (in memory: a reload ends the binge) ----
let lastFinished: { seriesId: string; at: number } | null = null;
/** The episode played to its end / on to Next Episode. */
export function noteFinished(item: Item | null) {
  if (item?.Type === 'Episode' && item.SeriesId) lastFinished = { seriesId: item.SeriesId, at: Date.now() };
}
const bingeing = (item: Item) => !!lastFinished && lastFinished.seriesId === item.SeriesId && Date.now() - lastFinished.at < BINGE_MS;

export const segStart = (s: Segment) => s.StartTicks / TICKS_PER_MS;
export const segEnd = (s: Segment) => s.EndTicks / TICKS_PER_MS;
export const segKey = (s: Segment) => s.Type + ':' + s.StartTicks;

/** Should this segment be skipped without asking? (Evaluated when playback enters it.) */
export function autoSkips(item: Item | null, s: Segment): boolean {
  const mode = settings.value.skipIntros ?? 'seen';
  if (!item || mode === 'ask') return false;
  if (s.Type !== 'Intro' && s.Type !== 'Recap') return false;
  const len = segEnd(s) - segStart(s);
  if (len <= 0 || len > MAX_SKIP_MS) return false;
  // A series premiere has nothing to recap: a "Recap" there is a mis-detected cold open (Edgerunners, New Girl S1E1).
  if (s.Type === 'Recap' && item.Type === 'Episode' && item.ParentIndexNumber === 1 && item.IndexNumber === 1) return false;
  if (mode === 'always') return true;
  if (item.Type !== 'Episode' || !item.SeriesId) return false; // movies: only with 'always'
  return s.Type === 'Intro' ? introSeen(item.SeriesId) : bingeing(item);
}

// ---- Next Episode timing ----
/** Credits after which more than this is left = a post-credits scene (Rick and Morty stingers): never auto-advance before it. */
const TAIL_MS = 20_000;
/** An Outro starting before this share of the runtime is a mis-detection (30 Rock S1E1: "credits" at 71%). */
const MIN_OUTRO_FRAC = 0.85;
/** No usable Outro: the card comes up this long before the end (the old fallback). */
const FALLBACK_MS = 40_000;

export interface NextTiming {
  /** Position where the Next card appears. */
  cardAt: number;
  /** True: the credits run to the end of the file, so the countdown may advance early. False: wait for the file end. */
  clean: boolean;
}

export function nextTiming(segments: Segment[], durMs: number): NextTiming {
  const o = segments.find((s) => s.Type === 'Outro');
  if (o && durMs > 0 && segStart(o) >= durMs * MIN_OUTRO_FRAC) return { cardAt: segStart(o), clean: durMs - segEnd(o) <= TAIL_MS };
  return { cardAt: durMs - FALLBACK_MS, clean: false };
}
