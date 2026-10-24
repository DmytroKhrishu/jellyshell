// Audio/subtitle choice memory: one entry per SERIES (episodes share it; movies and other items are keyed by their own id),
// persisted per Jellyfin user in localStorage `jellyshell.tracks.<userId>`. Only explicit picks (player Audio & Subtitles,
// subtitle toggle, detail page picker, a downloaded subtitle) write here; automatic defaults never do. Matching rules live
// in lib/trackmatch.ts. Jellyfin's own per-item memory (UserData.AudioStreamIndex/SubtitleStreamIndex, RememberAudio/
// SubtitleSelections) doesn't fight this: PlaybackInfo always gets explicit AudioStreamIndex/SubtitleStreamIndex (-1 = off)
// together with MediaSourceId, which the server honours over its remembered/default indexes.
import { auth, Item, MediaStream } from './jellyfin';
import { log } from './log';
import { TrackPref, audioPrefOf, subPrefOf } from './trackmatch';

const MAX = 300;
const key = () => `jellyshell.tracks.${auth.value?.userId ?? 'anon'}`;

function load(): Record<string, TrackPref> {
  try {
    return JSON.parse(localStorage.getItem(key()) || '{}') ?? {};
  } catch {
    return {};
  }
}
function save(all: Record<string, TrackPref>) {
  const ids = Object.keys(all);
  if (ids.length > MAX) ids.sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0)).slice(0, ids.length - MAX).forEach((id) => delete all[id]);
  try {
    localStorage.setItem(key(), JSON.stringify(all));
  } catch {}
}

/** Memory scope: the series for episodes, the item itself otherwise. */
export function trackScope(it: Item) {
  return it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id;
}

export function trackPref(it: Item): TrackPref | undefined {
  return load()[trackScope(it)];
}

function update(it: Item, fn: (p: TrackPref) => TrackPref) {
  const all = load();
  const id = trackScope(it);
  const prev = all[id] ?? {};
  // exact indexes are only meaningful for the item they were picked on
  const base: TrackPref = prev.item === it.Id ? prev : { audio: prev.audio, sub: prev.sub };
  all[id] = { ...fn(base), item: it.Id, at: Date.now() };
  save(all);
  return all[id];
}

/** Explicit audio pick. `all` = the item's current MediaStreams (PlaybackInfo / refreshed list). */
export function rememberAudio(it: Item, all: MediaStream[], index: number) {
  const s = all.find((m) => m.Type === 'Audio' && m.Index === index);
  if (!s) return;
  const p = update(it, (b) => ({ ...b, audio: audioPrefOf(s), audioIdx: index }));
  log('tracks remember audio', { scope: trackScope(it), item: it.Name, index, pref: p.audio });
}

/** Explicit subtitle pick; -1 = off (remembered as off for the whole series). */
export function rememberSub(it: Item, all: MediaStream[], index: number) {
  const s = index >= 0 ? all.find((m) => m.Type === 'Subtitle' && m.Index === index) : undefined;
  if (index >= 0 && !s) return;
  const p = update(it, (b) => ({ ...b, sub: s ? subPrefOf(s) : 'off', subIdx: index }));
  log('tracks remember sub', { scope: trackScope(it), item: it.Name, index, pref: p.sub });
}
