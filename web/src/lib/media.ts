import { Item, MediaStream } from './jellyfin';
import { settings, langName } from './settings';
import { resolveTracks } from './trackmatch';
import { trackPref, trackScope } from './trackmem';
import { log } from './log';

export function streams(it: Item): MediaStream[] {
  return it.MediaSources?.[0]?.MediaStreams ?? it.MediaStreams ?? [];
}

export function videoStream(it: Item) {
  return streams(it).find((s) => s.Type === 'Video');
}

export function audioLabel(s: MediaStream) {
  const ch = s.Channels ? (s.Channels >= 8 ? '7.1' : s.Channels >= 6 ? '5.1' : s.Channels === 2 ? 'Stereo' : s.Channels === 1 ? 'Mono' : `${s.Channels}ch`) : '';
  const codec = codecName(s.Codec);
  return [s.Title && !/^(english|stereo|surround)$/i.test(s.Title) ? s.Title : langName(s.Language), [codec, ch].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' · ');
}
export function subLabel(s: MediaStream) {
  const bits = [langName(s.Language)];
  if (s.IsForced) bits.push('Forced');
  if (/sdh|hearing/i.test(s.Title ?? s.DisplayTitle ?? '')) bits.push('SDH');
  if (s.Title && !bits.some((b) => s.Title!.includes(b)) && !/^(english|sdh)$/i.test(s.Title)) bits.push(s.Title);
  return bits.join(' · ');
}

function codecName(c?: string) {
  switch ((c || '').toLowerCase()) {
    case 'eac3': return 'Dolby Digital+';
    case 'ac3': return 'Dolby Digital';
    case 'truehd': return 'TrueHD';
    case 'dts': return 'DTS';
    case 'aac': return 'AAC';
    case 'flac': return 'FLAC';
    case 'opus': return 'Opus';
    case 'mp3': return 'MP3';
    default: return (c || '').toUpperCase();
  }
}

/** Badge texts for the metadata line. */
export function mediaBadges(it: Item): string[] {
  const out: string[] = [];
  const v = videoStream(it);
  if (v) {
    const w = v.Width ?? 0;
    const h = v.Height ?? 0;
    out.push(w >= 3200 || h >= 2000 ? '4K' : w >= 1800 || h >= 1000 ? 'HD 1080p' : h >= 700 ? 'HD 720p' : 'SD');
    const r = v.VideoRangeType ?? '';
    if (/DOVI/i.test(r)) out.push('Dolby Vision');
    else if (r === 'HDR10Plus') out.push('HDR10+');
    else if (r === 'HDR10') out.push('HDR10');
    else if (r === 'HLG') out.push('HLG');
  }
  const a = streams(it).filter((s) => s.Type === 'Audio');
  const best = a.find((s) => s.IsDefault) ?? a[0];
  if (best) {
    if (/atmos/i.test(best.DisplayTitle ?? '') || /atmos/i.test(best.Profile ?? '')) out.push('Dolby Atmos');
    else if (best.Codec === 'truehd') out.push('TrueHD');
    else if (best.Codec?.startsWith('dts')) out.push('DTS');
    else if (best.Codec === 'eac3' || best.Codec === 'ac3') out.push('Dolby Digital');
    if ((best.Channels ?? 0) >= 6) out.push(best.Channels! >= 8 ? '7.1' : '5.1');
  }
  if (streams(it).some((s) => s.Type === 'Subtitle')) out.push('CC');
  return out;
}

/**
 * Initial track picks: the series' remembered choice (lib/trackmem.ts, matched by language/forced/etc., not by index)
 * > Settings language > file default. `all` overrides the item's streams (e.g. a fresher PlaybackInfo list).
 */
export function pickTracks(it: Item, all: MediaStream[] = streams(it)) {
  const st = settings.value;
  const pref = trackPref(it);
  const r = resolveTracks(it.Id, all, pref, { audioLang: st.audioLang, subLang: st.subLang });
  if (pref) log('tracks pick', { scope: trackScope(it), item: it.Name, audio: r.audio, sub: r.sub, audioFrom: r.audioFrom, subFrom: r.subFrom });
  return { audio: r.audio, sub: r.sub };
}
