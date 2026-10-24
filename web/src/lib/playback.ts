// Playback session: DeviceProfile -> PlaybackInfo -> native `play`, Jellyfin progress reporting, WebVTT subtitles.
import { api, auth, DEVICE_ID, Item, MediaSource, MediaStream, TICKS_PER_MS } from './jellyfin';
import { capabilities, isNative, PlayMsg } from './bridge';
import { settings } from './settings';
import { audioBoost } from './audioboost';
import { log } from './log';

export function buildDeviceProfile(hdrSource = false) {
  const c = capabilities;
  // The MF "Dolby Digital Plus Decoder" handles both AC-3 and E-AC-3, but the per-subtype eac3 CodecQuery probe can crash
  // (then it's skipped forever). Missing eac3 made Jellyfin transcode DD+ titles to 4K H.264 HLS, which the Xbox can't keep up with.
  const native = c.audioNative.includes('ac3') ? [...c.audioNative, 'eac3'] : c.audioNative;
  const audioAll = [...new Set([...native, ...c.audioFfmpeg, ...(c.audioFfmpeg.includes('dts') ? ['dca', 'dts'] : [])])];
  if (!isNative) return browserProfile();
  // Native rule (docs/bridge.md notes): only MF-decodable codecs may direct play; av1 never (no HW decoder on Series S).
  const DP_VIDEO = ['h264', 'hevc', 'vp9', 'mpeg2video', 'vc1'];
  const video = c.video.filter((v) => DP_VIDEO.includes(v));
  const containers = [...new Set([...c.containers, 'mkv', 'mp4', 'm4v', 'mov', 'ts'])].filter((x) => x !== 'webm' || video.includes('vp9'));
  // HDR off (his TV is a dim SDR-only-in-practice panel): HDR10 / Dolby Vision / HLG files must NOT direct play. The
  // Xbox maps PQ to its SDR output itself and the result is very dim. Make Jellyfin tone-map on the server instead
  // (QSV tonemap_vaapi) into 4K HEVC SDR, which the console decodes in hardware (≈1.7x realtime on the i5-9400T).
  const toneMap = settings.value.hdr === 'off';
  const sdrOnly = toneMap
    ? ['hevc', 'vp9', 'h264'].map((codec) => ({ Type: 'Video', Codec: codec, Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: true }] }))
    : [];
  return {
    Name: 'JellyShell Xbox',
    MaxStreamingBitrate: 200_000_000,
    MaxStaticBitrate: 200_000_000,
    MusicStreamingTranscodingBitrate: 640000,
    DirectPlayProfiles: [
      { Container: containers.join(','), Type: 'Video', VideoCodec: (video.length ? video : ['h264', 'hevc']).join(','), AudioCodec: audioAll.join(',') },
      { Container: 'mp3,flac,aac,m4a,opus,ogg', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: toneMap && hdrSource ? 'mp4' : 'ts', // HEVC in HLS needs fMP4 segments (MF finds no video track in TS)
        Type: 'Video',
        Protocol: 'hls',
        // Tone-mapped HDR -> 4K HEVC SDR (h264 at 4K is too heavy for the console's decoder). Everything else stays h264.
        VideoCodec: toneMap && hdrSource ? 'hevc,h264' : 'h264',
        AudioCodec: 'eac3,ac3,aac',
        Context: 'Streaming',
        MaxAudioChannels: '6',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      { Type: 'VideoAudio', Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(c.maxAudioChannels), IsRequired: false }] },
      ...sdrOnly,
    ],
    SubtitleProfiles: subtitleProfiles(),
  };
}

/** Desktop browser (Chrome / Safari / Firefox): probe what this <video> actually decodes. Everything else -> HLS h264/aac. */
function browserProfile() {
  const v = document.createElement('video');
  const can = (t: string) => {
    try {
      const MSE = (window as any).MediaSource as { isTypeSupported(t: string): boolean } | undefined;
      return v.canPlayType(t) !== '' || !!MSE?.isTypeSupported(t);
    } catch {
      return false;
    }
  };
  const mp4Video = ['h264'];
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) mp4Video.push('hevc');
  if (can('video/mp4; codecs="av01.0.08M.08"')) mp4Video.push('av1');
  if (can('video/mp4; codecs="vp09.00.10.08"')) mp4Video.push('vp9');
  const mp4Audio = ['aac', 'mp3'];
  if (can('audio/mp4; codecs="opus"')) mp4Audio.push('opus');
  if (can('audio/mp4; codecs="flac"')) mp4Audio.push('flac');
  if (can('audio/mp4; codecs="ac-3"')) mp4Audio.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) mp4Audio.push('eac3');
  const webm = can('video/webm; codecs="vp9,opus"');
  const dp: any[] = [{ Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: mp4Video.join(','), AudioCodec: mp4Audio.join(',') }];
  if (webm) dp.push({ Container: 'webm', Type: 'Video', VideoCodec: ['vp8', 'vp9', ...(mp4Video.includes('av1') ? ['av1'] : [])].join(','), AudioCodec: 'vorbis,opus' });
  // Apple WebKit (iOS/iPadOS/macOS Safari) only decodes HEVC tagged hvc1 (or Dolby Vision dvh1); hev1 must transcode.
  const ua = navigator.userAgent;
  const apple = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Android|Edg/.test(ua);
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const hevcTag = apple && mp4Video.includes('hevc') ? [{ Type: 'Video', Codec: 'hevc', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|dvh1', IsRequired: true }] }] : [];
  // Android wrapper APKs (android/, UA marker JellyShellTV/ or JellyShellMobile/): MSE can't take MKV, so without this every HEVC file
  // (most of the library) is fully re-encoded to h264. fMP4 HLS lets Jellyfin COPY the HEVC stream (remux) when the
  // TV's decoder handles it; Main10 only if the WebView reports it. HDR stays out (tone-mapped to SDR server-side).
  const atv = /JellyShell(TV|Mobile)\//.test(ua) && mp4Video.includes('hevc');
  const main10 = atv && can('video/mp4; codecs="hvc1.2.4.L153.B0"');
  const atvHevc = atv
    ? [{ Type: 'Video', Codec: 'hevc', Conditions: [
        { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: true },
        { Condition: 'EqualsAny', Property: 'VideoProfile', Value: main10 ? 'main|main 10' : 'main', IsRequired: true },
      ] }]
    : [];
  const transcoding: any[] = [
    { Container: 'ts', Type: 'Video', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac,mp3', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true },
  ];
  if (atv) transcoding.unshift({ Container: 'mp4', Type: 'Video', Protocol: 'hls', VideoCodec: 'hevc,h264', AudioCodec: 'aac,mp3', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true });
  log('browser profile', { mp4Video, mp4Audio, webm, apple, ios, atv, main10 });
  return {
    Name: ios ? 'JellyShell (iOS Safari)' : /JellyShellTV\//.test(ua) ? 'JellyShell (Android TV)' : /JellyShellMobile\//.test(ua) ? 'JellyShell (Android app)' : /Android/.test(ua) ? 'JellyShell (Android browser)' : 'JellyShell (desktop browser)',
    MaxStreamingBitrate: 120_000_000,
    MaxStaticBitrate: 120_000_000,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: dp,
    TranscodingProfiles: transcoding,
    ContainerProfiles: [],
    CodecProfiles: [
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }] },
      ...hevcTag,
      ...atvHevc,
    ],
    SubtitleProfiles: subtitleProfiles(),
  };
}

function subtitleProfiles() {
  // Text subs are delivered as WebVTT and drawn by the web layer; image subs (PGS/VobSub) must be burned in.
  return [
    ...['vtt', 'srt', 'subrip', 'ass', 'ssa', 'ttml', 'webvtt', 'sub', 'smi', 'mov_text'].map((f) => ({ Format: f, Method: 'External' })),
    ...['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].map((f) => ({ Format: f, Method: 'Encode' })),
  ];
}

export interface PlaybackInfoResult {
  MediaSources: MediaSource[];
  PlaySessionId: string;
  ErrorCode?: string;
}

export interface Session {
  item: Item;
  source: MediaSource;
  playSessionId: string;
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
  url: string;
  audioIndex?: number; // Jellyfin stream index
  subIndex: number; // Jellyfin stream index, -1 = off
  startMs: number;
}

export async function getPlaybackInfo(it: Item, opts: { startMs: number; audioIndex?: number; subIndex: number; forceTranscode?: boolean }) {
  const a = auth.value!;
  const v = (it.MediaSources?.[0]?.MediaStreams ?? it.MediaStreams ?? []).find((m) => m.Type === 'Video');
  const profile = buildDeviceProfile(!!v?.VideoRangeType && v.VideoRangeType !== 'SDR');
  const body = {
    UserId: a.userId,
    DeviceProfile: profile,
    StartTimeTicks: Math.round(opts.startMs * TICKS_PER_MS),
    AudioStreamIndex: opts.audioIndex,
    // -1 = off, sent explicitly: omitted, Jellyfin substitutes its own default/remembered track (and may burn it in).
    SubtitleStreamIndex: opts.subIndex >= 0 ? opts.subIndex : -1,
    MediaSourceId: it.MediaSources?.[0]?.Id ?? it.Id,
    MaxStreamingBitrate: profile.MaxStreamingBitrate,
    EnableDirectPlay: !opts.forceTranscode,
    EnableDirectStream: !opts.forceTranscode,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: true,
  };
  const r = await api<PlaybackInfoResult>(`/Items/${it.Id}/PlaybackInfo?userId=${a.userId}`, { body });
  if (r.ErrorCode) throw new Error('PlaybackInfo: ' + r.ErrorCode);
  const src = r.MediaSources?.[0];
  if (!src) throw new Error('PlaybackInfo returned no media source');
  return { r, src };
}

export function streamUrl(it: Item, src: MediaSource, playSessionId: string) {
  const a = auth.value!;
  const server = a.server.replace(/\/+$/, '');
  if (src.SupportsDirectPlay || (src.SupportsDirectStream && !src.TranscodingUrl)) {
    const q = new URLSearchParams({
      static: 'true',
      mediaSourceId: src.Id,
      deviceId: DEVICE_ID,
      PlaySessionId: playSessionId,
      api_key: a.token,
    });
    if (src.ETag) q.set('Tag', src.ETag);
    return { url: `${server}/Videos/${it.Id}/stream?${q}`, method: 'DirectPlay' as const };
  }
  if (src.TranscodingUrl) {
    let u = server + src.TranscodingUrl;
    if (!/api_key=|ApiKey=/i.test(u)) u += (u.includes('?') ? '&' : '?') + 'api_key=' + a.token;
    return { url: u, method: (/\bVideoCodec=copy|videocodec=copy/i.test(u) ? 'DirectStream' : 'Transcode') as Session['playMethod'] };
  }
  throw new Error('No playable stream: server allows neither direct play nor transcoding for this item.');
}

export function buildPlayMsg(s: Session): PlayMsg {
  const st = settings.value;
  const v = s.source.MediaStreams.find((m) => m.Type === 'Video');
  const audios = s.source.MediaStreams.filter((m) => m.Type === 'Audio');
  const aud = audios.find((m) => m.Index === s.audioIndex) ?? audios[0];
  const ordinal = s.playMethod === 'DirectPlay' && aud ? audios.indexOf(aud) : undefined;
  // For HLS the fields must describe the OUTPUT stream, not the source (native picks its decoder from them).
  let videoCodec = v?.Codec;
  let audioCodec = aud?.Codec;
  let range = v?.VideoRangeType ?? 'SDR';
  let width = v?.Width;
  let height = v?.Height;
  if (s.playMethod !== 'DirectPlay') {
    const q = new URLSearchParams(s.url.split('?')[1] ?? '');
    const reasons = q.get('TranscodeReasons') ?? '';
    const vReq = (q.get('VideoCodec') ?? '').split(',')[0];
    const videoTranscoded = !/videocodec=copy/i.test(s.url) && /Video|Container|Bitrate|Resolution|Framerate|Level|Profile|Range|BitDepth|Anamorphic|Interlaced|RefFrames/i.test(reasons) && !!vReq;
    if (videoTranscoded) {
      videoCodec = vReq;
      range = 'SDR'; // Jellyfin tone-maps / outputs SDR for h264
      const mw = Number(q.get('MaxWidth') || q.get('Width') || 0);
      if (mw && width && width > mw) {
        height = height ? Math.round((height * mw) / width) : height;
        width = mw;
      }
    }
    const audioTranscoded = /Audio/i.test(reasons) || (aud && !(q.get('AudioCodec') ?? '').split(',').includes(aud.Codec ?? ''));
    if (audioTranscoded && q.get('AudioCodec')) audioCodec = q.get('AudioCodec')!.split(',')[0];
  }
  return {
    url: s.url,
    itemId: s.item.Id,
    startMs: Math.round(s.startMs),
    container: s.playMethod === 'DirectPlay' ? s.source.Container : 'hls',
    videoCodec,
    audioCodec,
    videoRangeType: range,
    width,
    height,
    fps: v?.RealFrameRate ?? v?.AverageFrameRate,
    hdr: st.hdr,
    matchFrameRate: st.matchFrameRate,
    audioStreamIndex: ordinal !== undefined && audios.length > 1 ? ordinal : undefined,
    audioBoost: { ...audioBoost.value },
  };
}

// ---------------- reporting ----------------
function report(path: string, s: Session, positionMs: number, extra: Record<string, unknown> = {}) {
  return api(path, {
    body: {
      ItemId: s.item.Id,
      MediaSourceId: s.source.Id,
      PlaySessionId: s.playSessionId,
      PositionTicks: Math.max(0, Math.round(positionMs * TICKS_PER_MS)),
      PlayMethod: s.playMethod,
      AudioStreamIndex: s.audioIndex,
      SubtitleStreamIndex: s.subIndex,
      CanSeek: true,
      ...extra,
    },
  }).catch((e) => log('report failed', path, String(e)));
}
export const reportStart = (s: Session, ms: number) => report('/Sessions/Playing', s, ms, { IsPaused: false });
export const reportProgress = (s: Session, ms: number, paused: boolean, event = 'TimeUpdate') =>
  report('/Sessions/Playing/Progress', s, ms, { IsPaused: paused, EventName: event });
export async function reportStopped(s: Session, ms: number) {
  await report('/Sessions/Playing/Stopped', s, ms);
  if (s.playMethod !== 'DirectPlay') {
    api(`/Videos/ActiveEncodings?deviceId=${encodeURIComponent(DEVICE_ID)}&playSessionId=${s.playSessionId}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ---------------- media segments ----------------
export interface Segment {
  Type: 'Intro' | 'Outro' | 'Recap' | 'Preview' | 'Commercial' | 'Unknown' | string;
  StartTicks: number;
  EndTicks: number;
}
export async function mediaSegments(id: string): Promise<Segment[]> {
  try {
    const r = await api<{ Items: Segment[] }>(`/MediaSegments/${id}`);
    return r?.Items ?? [];
  } catch {
    return []; // 404 / older server: no skip button
  }
}

// ---------------- WebVTT ----------------
export interface Cue {
  start: number; // ms
  end: number;
  text: string;
}

export function subtitleUrl(s: Session, sub: MediaStream) {
  const a = auth.value!;
  const server = a.server.replace(/\/+$/, '');
  if (sub.DeliveryUrl) {
    const u = sub.DeliveryUrl.startsWith('http') ? sub.DeliveryUrl : server + sub.DeliveryUrl;
    // Ask for WebVTT regardless of what the profile matched.
    const vtt = u.replace(/\/Stream\.\w+(\?|$)/i, '/Stream.vtt$1');
    return vtt.includes('api_key') || vtt.includes('ApiKey') ? vtt : vtt + (vtt.includes('?') ? '&' : '?') + 'api_key=' + a.token;
  }
  return `${server}/Videos/${s.item.Id}/${s.source.Id}/Subtitles/${sub.Index}/0/Stream.vtt?api_key=${a.token}`;
}

export async function loadVtt(url: string): Promise<Cue[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`subtitle ${res.status}`);
  return parseVtt(await res.text());
}

function ts(t: string) {
  const p = t.trim().replace(',', '.').split(':');
  let s = 0;
  for (const x of p) s = s * 60 + parseFloat(x);
  return Math.round(s * 1000);
}

export function parseVtt(src: string): Cue[] {
  const out: Cue[] = [];
  const blocks = src.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const text = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<(?!\/?[ibu]>)[^>]+>/g, '') // keep <i>/<b>/<u>, drop voice/class/ruby tags
      .replace(/\{\\[^}]*\}/g, '') // stray ASS overrides
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '‹')
      .replace(/&gt;/g, '›')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (text) out.push({ start: ts(a), end: ts(z.trim().split(/\s+/)[0]), text });
  }
  return out.sort((x, y) => x.start - y.start);
}

export function cuesAt(cues: Cue[], ms: number): Cue[] {
  // binary search for the first cue with start <= ms, then scan back for overlaps
  let lo = 0,
    hi = cues.length - 1,
    idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= ms) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: Cue[] = [];
  for (let i = idx; i >= 0 && i > idx - 8; i--) if (cues[i].end > ms) out.unshift(cues[i]);
  return out;
}
