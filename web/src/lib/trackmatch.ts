// Pure audio/subtitle matching for the per-series track memory (lib/trackmem.ts). No imports with side effects, so a
// scratch script can bundle this file alone and test it against real MediaStreams.
//
// Stream indexes are NOT stable across episodes (S1 vs S2 files of the same show have different track orders and counts,
// and a forced track shifts every index after it), so a choice is remembered by attributes and re-resolved per file:
//   audio:    Language (required) > channel count > title kind (commentary / description) > title similarity > codec
//   subtitle: Language (required) > IsForced (required) > hearing-impaired > title kind (songs/signs/dubtitle) > external/codec
import type { MediaStream } from './jellyfin';

export interface AudioPref {
  lang: string; // normalized ISO 639-2/T ('und' = untagged)
  channels?: number;
  title?: string;
  codec?: string;
}
export interface SubPref {
  lang: string;
  forced: boolean;
  hi: boolean;
  title?: string;
  external?: boolean;
  codec?: string;
}
export interface TrackPref {
  audio?: AudioPref;
  sub?: SubPref | 'off';
  /** Item the choice was made on + its exact indexes: that file reuses them verbatim. */
  item?: string;
  audioIdx?: number;
  subIdx?: number;
  at?: number;
}

// ISO 639-2/B → 639-2/T and common 639-1 codes, so 'ger'/'de'/'deu' all compare equal.
const ALIAS: Record<string, string> = {
  ger: 'deu', fre: 'fra', cze: 'ces', chi: 'zho', dut: 'nld', gre: 'ell', rum: 'ron', per: 'fas', slo: 'slk', baq: 'eus', arm: 'hye', geo: 'kat',
  ice: 'isl', mac: 'mkd', may: 'msa', alb: 'sqi', bur: 'mya', wel: 'cym', tib: 'bod', scc: 'srp', scr: 'hrv',
  en: 'eng', uk: 'ukr', ru: 'rus', cs: 'ces', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'zho', pt: 'por',
  nl: 'nld', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan', fi: 'fin', hu: 'hun', tr: 'tur', ar: 'ara', he: 'heb', el: 'ell', ro: 'ron', sk: 'slk',
};
export function normLang(l?: string | null) {
  const c = (l || '').trim().toLowerCase();
  if (!c || c === 'unknown' || c === 'und' || c === 'mis' || c === 'zxx') return 'und';
  return ALIAS[c] ?? c;
}

/** Words in a track title that mean a different KIND of track, not a different release. */
const KIND = /\b(commentary|comment|description|descriptive|ad|songs?|signs?|dubtitles?)\b/gi;
function kinds(t?: string) {
  return new Set((t || '').toLowerCase().match(KIND)?.map((k) => k.replace(/s$/, '').replace(/^comment$/, 'commentary').replace(/^descriptive$/, 'description')) ?? []);
}
function tokens(t?: string) {
  return new Set((t || '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size && !b.size) return 1;
  let n = 0;
  a.forEach((x) => b.has(x) && n++);
  return n / (a.size + b.size - n);
}
function kindPenalty(a?: string, b?: string) {
  const ka = kinds(a);
  const kb = kinds(b);
  let d = 0;
  ka.forEach((k) => !kb.has(k) && d++);
  kb.forEach((k) => !ka.has(k) && d++);
  return d;
}
const isHI = (s: MediaStream) => !!(s as any).IsHearingImpaired || /\b(sdh|cc|hearing)\b/i.test(s.Title ?? '');

export function audioPrefOf(s: MediaStream): AudioPref {
  return { lang: normLang(s.Language), channels: s.Channels, title: s.Title || undefined, codec: s.Codec };
}
export function subPrefOf(s: MediaStream): SubPref {
  return { lang: normLang(s.Language), forced: !!s.IsForced, hi: isHI(s), title: s.Title || undefined, external: !!s.IsExternal, codec: s.Codec };
}

function best<T>(xs: T[], score: (x: T) => number): T | undefined {
  let top: T | undefined;
  let ts = -Infinity;
  for (const x of xs) {
    const s = score(x);
    if (s > ts) (top = x), (ts = s);
  }
  return top;
}

/** Best audio stream for the remembered choice, or undefined when no stream has that language. */
export function matchAudio(audios: MediaStream[], p: AudioPref): MediaStream | undefined {
  const cand = audios.filter((s) => normLang(s.Language) === p.lang);
  return best(cand, (s) => {
    let sc = 0;
    if (p.channels && s.Channels) sc += s.Channels === p.channels ? 4 : -Math.min(3, Math.abs(s.Channels - p.channels) * 0.5);
    sc -= kindPenalty(p.title, s.Title) * 3;
    sc += jaccard(tokens(p.title), tokens(s.Title));
    if (p.codec && s.Codec === p.codec) sc += 0.5;
    if (s.IsDefault) sc += 0.1;
    return sc;
  });
}

/** Best subtitle stream for the remembered choice, or undefined when no stream has that language + forced flag. */
export function matchSub(subs: MediaStream[], p: SubPref): MediaStream | undefined {
  const cand = subs.filter((s) => normLang(s.Language) === p.lang && !!s.IsForced === p.forced);
  return best(cand, (s) => {
    let sc = 0;
    if (isHI(s) === p.hi) sc += 4;
    sc -= kindPenalty(p.title, s.Title) * 3;
    sc += jaccard(tokens(p.title), tokens(s.Title));
    if (p.external !== undefined && !!s.IsExternal === p.external) sc += 0.5;
    if (p.codec && s.Codec === p.codec) sc += 0.25;
    if (s.IsDefault) sc += 0.1;
    return sc;
  });
}

export interface Defaults {
  audioLang: string; // '' = file default
  subLang: string; // 'off' | '' | iso639-2
}

/** Settings-based defaults (the pre-memory behaviour): settings language > file default. */
export function defaultAudio(audios: MediaStream[], d: Defaults) {
  const byLang = d.audioLang ? audios.find((s) => normLang(s.Language) === normLang(d.audioLang)) : undefined;
  return (byLang ?? audios.find((s) => s.IsDefault) ?? audios[0])?.Index;
}
export function defaultSub(subs: MediaStream[], d: Defaults, playingLang?: string) {
  if (d.subLang === 'off') {
    // forced only (signs/songs), and only one meant for the audio that is actually playing: a remembered English dub
    // must not pick up the Japanese 'Forced' track of the same file
    const al = playingLang && normLang(playingLang) !== 'und' ? normLang(playingLang) : d.audioLang ? normLang(d.audioLang) : '';
    return subs.find((s) => s.IsForced && (!al || normLang(s.Language) === al))?.Index ?? -1;
  }
  if (d.subLang) {
    const l = normLang(d.subLang);
    return (subs.find((s) => normLang(s.Language) === l && !s.IsForced) ?? subs.find((s) => normLang(s.Language) === l))?.Index ?? -1;
  }
  return subs.find((s) => s.IsDefault || s.IsForced)?.Index ?? -1;
}

function sameAttrs<T extends object>(a: T, b: T | undefined) {
  if (!b) return false;
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof T>;
  for (const k of ks) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

/**
 * Resolve the tracks for one file. Remembered choice first (exact indexes on the item it was made on, attribute match
 * elsewhere); a remembered language the file doesn't have falls back to the Settings defaults for this file only.
 */
export function resolveTracks(itemId: string, all: MediaStream[], pref: TrackPref | undefined, d: Defaults) {
  const audios = all.filter((s) => s.Type === 'Audio');
  const subs = all.filter((s) => s.Type === 'Subtitle');
  const same = !!pref && pref.item === itemId;
  let audio: number | undefined;
  let audioFrom = 'default';
  // Same file: reuse the exact index (tells identical-looking tracks apart) while it still points at the same track;
  // indexes can shift on that file too when an external subtitle is added, then the attribute match takes over.
  const exA = same && pref!.audio ? audios.find((s) => s.Index === pref!.audioIdx) : undefined;
  if (exA && sameAttrs(audioPrefOf(exA), pref!.audio)) (audio = exA.Index), (audioFrom = 'exact');
  else if (pref?.audio) {
    const m = matchAudio(audios, pref.audio);
    if (m) (audio = m.Index), (audioFrom = 'memory');
  }
  if (audio === undefined) audio = defaultAudio(audios, d);
  const playingLang = audios.find((s) => s.Index === audio)?.Language;
  let sub: number | undefined;
  let subFrom = 'default';
  const sp = pref?.sub && pref.sub !== 'off' ? pref.sub : undefined;
  const exS = same && sp ? subs.find((s) => s.Index === pref!.subIdx) : undefined;
  if (pref?.sub === 'off') (sub = -1), (subFrom = 'memory');
  else if (exS && sameAttrs(subPrefOf(exS), sp)) (sub = exS.Index), (subFrom = 'exact');
  else if (sp) {
    const m = matchSub(subs, sp);
    if (m) (sub = m.Index), (subFrom = 'memory');
  }
  if (sub === undefined) sub = defaultSub(subs, d, playingLang);
  return { audio, sub, audioFrom, subFrom };
}
