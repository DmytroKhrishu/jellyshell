// Phone remote ⇄ player (docs/remote.md "Now playing"). The Player hands over its live values and its OWN handlers every
// render; this hook registers lib/remote.ts `nowPlaying` (a serializable state snapshot + an op dispatcher) and posts on
// discrete changes. Every phone op runs the same function the TV's buttons / dialogs run (track memory, boost persistence,
// picture restart, Next / episode switch), so nothing about playback is re-implemented here.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Item, MediaStream, episodes, episodeLabel } from '../lib/jellyfin';
import { audioLabel, subLabel } from '../lib/media';
import { nowPlaying, playerChanged, remoteLive, PlayerOp, PlayerState } from '../lib/remote';
import { audioBoost, BOOST_STEPS, boostAck, boostAvailable, boostLabel, setBoost } from '../lib/audioboost';
import { picture, BRIGHTNESS, CONTRAST } from '../lib/picture';
import { fmtOffset } from '../lib/subs';
import { log } from '../lib/log';

export interface RemotePlayerProps {
  it: Item | null;
  title: string;
  subtitle: string;
  paused: boolean;
  buffering: boolean;
  pos: () => number;
  dur: number;
  audios: MediaStream[];
  subs: MediaStream[];
  audioIndex: number;
  subIndex: number;
  subOff: number;
  pictureOk: boolean; // the TV shows the sun button (tone-mapped HDR + canEdit)
  next: Item | null;
  seg: string | null;
  skipMs: number;
  // the player's own handlers
  togglePause: () => void;
  seekTo: (ms: number) => void;
  flash: (text: string, ms?: number) => void;
  setAudio: (index: number) => void;
  setSub: (index: number) => void;
  nudge: (deltaMs: number) => number | undefined;
  applyPicture: (v: { brightness?: number; contrast?: number }) => void;
  playNext: (n: Item) => void;
  switchEpisode: (n: Item) => void;
  skipSeg: () => void;
  showUi: () => void;
}

const cut = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

export function useRemotePlayer(p: RemotePlayerProps) {
  const ref = useRef(p);
  ref.current = p;
  const it = p.it;

  // The current season's episodes, only while a phone is paired (one request per season, like the Episodes panel).
  const [eps, setEps] = useState<Item[] | null>(null);
  const live = remoteLive.value;
  useEffect(() => {
    setEps(null);
    if (!live || it?.Type !== 'Episode' || !it.SeriesId || !it.SeasonId) return;
    let off = false;
    episodes(it.SeriesId, it.SeasonId)
      .then((r) => !off && setEps(r.Items))
      .catch((e) => log('remote: episodes failed', String(e)));
    return () => void (off = true);
  }, [live, it?.SeriesId, it?.SeasonId]);
  const epsRef = useRef(eps);
  epsRef.current = eps;

  const state = (): PlayerState => {
    const c = ref.current;
    const i = c.it!;
    const textSubOn = c.subIndex >= 0 && !!c.subs.find((x) => x.Index === c.subIndex)?.IsTextSubtitleStream;
    const ack = boostAck.value;
    const pic = picture.value;
    const list = epsRef.current;
    return {
      title: cut(c.title, 120),
      sub: cut(c.subtitle, 120) || undefined,
      paused: c.paused,
      buffering: c.buffering || undefined,
      pos: Math.round(c.pos()),
      dur: Math.round(c.dur),
      name: cut(i.Name, 120),
      series: i.Type === 'Episode' ? cut(i.SeriesName, 120) : undefined,
      art:
        i.Type === 'Episode' && i.SeriesId && i.SeriesPrimaryImageTag
          ? { id: i.SeriesId, tag: i.SeriesPrimaryImageTag }
          : i.ImageTags?.Primary
            ? { id: i.Id, tag: i.ImageTags.Primary }
            : undefined,
      skipMs: c.skipMs,
      audio: c.audios.slice(0, 40).map((a) => ({ i: a.Index, label: cut(audioLabel(a), 80) })),
      a: c.audioIndex,
      // Same rows as the TV's Audio & Subtitles dialog (Off is the phone's own first row).
      subs: c.subs.slice(0, 60).map((x) => ({ i: x.Index, label: cut(subLabel(x), 80), note: x.IsTextSubtitleStream ? (x.IsExternal ? 'External' : undefined) : 'burn-in' })),
      s: c.subIndex,
      subOff: textSubOn ? c.subOff : null,
      boost: {
        ok: boostAvailable(),
        db: audioBoost.value.db,
        night: audioBoost.value.night,
        steps: BOOST_STEPS,
        note: ack && !ack.applied ? cut(ack.reason ?? 'not applied', 60) : undefined,
      },
      pic: c.pictureOk && pic ? { b: pic.brightness, c: pic.contrast, bs: BRIGHTNESS, cs: CONTRAST } : null,
      next: c.next ? { id: c.next.Id, label: cut(c.next.Type === 'Episode' ? `${episodeLabel(c.next)} · ${c.next.Name}` : c.next.Name, 100) } : null,
      seg: c.seg,
      eps: list
        ? list.slice(0, 80).map((e) => ({ id: e.Id, label: episodeLabel(e), name: cut(e.Name, 60), played: e.UserData?.Played || undefined, now: e.Id === i.Id || undefined }))
        : null,
    };
  };

  const act = (o: PlayerOp) => {
    const c = ref.current;
    if (!c.it) return;
    switch (o.op) {
      case 'pp':
        c.togglePause();
        c.showUi();
        return;
      case 'play':
      case 'pause':
        if (c.paused === (o.op === 'play')) c.togglePause();
        return;
      case 'seek':
        c.seekTo(o.ms);
        return;
      case 'skip':
        c.seekTo(c.pos() + o.ms);
        c.flash((o.ms > 0 ? '+' : '−') + Math.round(Math.abs(o.ms) / 1000) + ' s', 700);
        return;
      case 'next':
        if (c.next) c.playNext(c.next);
        return;
      case 'skipSeg':
        c.skipSeg();
        return;
      case 'audio': {
        const a = c.audios.find((x) => x.Index === o.i);
        if (!a || a.Index === c.audioIndex) return;
        c.setAudio(a.Index);
        c.flash(audioLabel(a), 1500);
        return;
      }
      case 'sub': {
        if (o.i === c.subIndex) return;
        const s = c.subs.find((x) => x.Index === o.i);
        if (o.i >= 0 && !s) return;
        c.setSub(o.i);
        c.flash(s ? subLabel(s) + ' · on' : 'Subtitles off', 1500);
        return;
      }
      case 'subOff': {
        const v = c.nudge(o.d);
        if (v !== undefined) c.flash('Subtitle timing ' + fmtOffset(v), 1200);
        return;
      }
      case 'boost':
        if (!boostAvailable() || !BOOST_STEPS.includes(o.db)) return;
        setBoost({ db: o.db });
        c.flash('Audio boost ' + boostLabel(audioBoost.value.db));
        return;
      case 'night':
        if (!boostAvailable()) return;
        setBoost({ night: o.on });
        c.flash('Night mode ' + (audioBoost.value.night ? 'on' : 'off'));
        return;
      case 'pic': {
        if (!c.pictureOk || !picture.value) return;
        const v: { brightness?: number; contrast?: number } = {};
        if (o.b !== undefined && BRIGHTNESS.some((x) => x[0] === o.b)) v.brightness = o.b;
        if (o.c !== undefined && CONTRAST.some((x) => x[0] === o.c)) v.contrast = o.c;
        if (v.brightness !== undefined || v.contrast !== undefined) c.applyPicture(v);
        return;
      }
      case 'ep': {
        const e = epsRef.current?.find((x) => x.Id === o.id);
        if (e && e.Id !== c.it.Id) c.switchEpisode(e);
        return;
      }
    }
  };

  useEffect(() => {
    nowPlaying.value = it ? { state, act } : null;
  }, [it]);
  useEffect(() => () => void (nowPlaying.value = null), []);

  // Post on discrete changes (pause, tracks, boost, picture, next, segment, episodes); position rides the 5 s tick in
  // lib/remote.ts, plus a post when it jumps (a seek on the TV) so the phone doesn't interpolate from a stale point.
  const sig = [p.paused, p.buffering, Math.round(p.dur / 1000), p.audioIndex, p.subIndex, p.subOff, p.pictureOk, p.next?.Id, p.seg, eps?.length,
    audioBoost.value.db, audioBoost.value.night, boostAck.value?.applied, picture.value?.brightness, picture.value?.contrast, p.audios.length, p.subs.length].join('|');
  useEffect(() => {
    if (it) playerChanged();
  }, [sig]);
  const last = useRef({ pos: 0, t: 0 });
  const pos = p.pos();
  useEffect(() => {
    const now = performance.now();
    const l = last.current;
    const expect = l.pos + (p.paused ? 0 : now - l.t);
    last.current = { pos, t: now };
    if (it && l.t && Math.abs(pos - expect) > 3000) playerChanged();
  }, [pos]);
}
