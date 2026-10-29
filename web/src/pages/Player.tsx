import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { openPicker, dialog, Opt } from '../components/Dialog';
import {
  Item, item as getItem, cachedItem, fmtClock, TICKS_PER_MS, episodeLabel, nextEpisodeAfter, MediaStream, backdropUrl,
} from '../lib/jellyfin';
import { EpisodesPanel } from '../components/EpisodesPanel';
import '../styles/player-controls.css';
import { setBackdrop } from '../components/Backdrop';
import { onNative, send, isNative } from '../lib/bridge';
import { pushHandler, onRelease, ActionEvent, Action } from '../lib/input';
import { focusEl, current, move } from '../lib/focus';
import { pop, replaceTop } from '../lib/router';
import {
  Session, getPlaybackInfo, streamUrl, buildPlayMsg, reportStart, reportProgress, reportStopped, mediaSegments, Segment,
  Cue, loadVtt, subtitleUrl, cuesAt,
} from '../lib/playback';
import { pickTracks, audioLabel, subLabel } from '../lib/media';
import { rememberAudio, rememberSub } from '../lib/trackmem';
import { log } from '../lib/log';
import { endsAt, fmtTime } from '../lib/clock';
import { finder, openFinder } from '../components/SubtitleFinder';
import { caps } from '../lib/caps';
import { ItemSubs, itemSubs, syncSub, deleteSub, subOffset, setSubOffset, fmtOffset, fmtMin } from '../lib/subs';
import { showToast } from '../components/Dialog';
import { MobilePlayerLayer, toggleFullscreen } from '../components/MobilePlayer';
import { uiMode, isAndroidTV } from '../lib/mode';
import { Icon } from '../components/icons';
import { picture, loadPicture } from '../lib/picture';
import { applyPicture, openPictureDialog } from '../components/PictureDialog';
import { settings } from '../lib/settings';
import { audioBoost, BOOST_STEPS, boostAck, boostAvailable, boostLabel, setBoost } from '../lib/audioboost';
import { useStillWatching } from '../components/StillWatching';
import { stillWatching } from '../lib/idle';
import { useAutoSkip } from '../components/AutoSkip';
import { NextCard, nextAutoplayMode, nextLabel, useNextCountdown } from '../components/NextCountdown';
import { nextTiming, noteFinished, segEnd } from '../lib/introskip';
import { useRemotePlayer } from '../components/RemotePlayer';
import { useCreditsShelf } from '../components/CreditsShelf';
import type { SItem } from '../lib/seerr';

const HIDE_MS = 8000;
const WAKE_HINT_MS = 4000;
const PROGRESS_MS = 10_000;

interface NativeTrack {
  index: number;
  codec: string;
  channels: number;
  language: string;
  title: string;
}

export function Player({ id, startMs: startOverride, fromStart }: { id: string; startMs?: number; fromStart?: boolean }) {
  const [it, setIt] = useState<Item | null>(null);
  const [sess, setSess] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [state, setState] = useState<string>('Opening');
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [buf, setBuf] = useState(0);
  const [ui, setUi] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);
  const [osd, setOsd] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [next, setNext] = useState<Item | null>(null);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [nativeTracks, setNativeTracks] = useState<NativeTrack[]>([]);
  const [decoder, setDecoder] = useState<string>('');
  const [videoSize, setVideoSize] = useState<string>('');
  const [showInfo, setShowInfo] = useState(false);
  const [, setFsTick] = useState(0); // re-render the fullscreen icon (also on Esc / F)
  useEffect(() => {
    const on = () => setFsTick((n) => n + 1);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const [showEps, setShowEps] = useState(false);
  const [starting, setStarting] = useState(true); // until the first frame: keep the backdrop, show "Starting…"
  const [wakeHint, setWakeHint] = useState(false);
  const [subOff, setSubOff] = useState(() => subOffset(id)); // manual timing offset (ms), per item
  const [subTask, setSubTask] = useState<string | null>(null); // long subtitle job in progress ("Syncing…")
  const subInfo = useRef<ItemSubs | null>(null);
  const t0 = useRef(performance.now());
  const marks = useRef<Record<string, number>>({});
  const mark = (k: string) => {
    if (marks.current[k] === undefined) marks.current[k] = Math.round(performance.now() - t0.current);
  };
  const [, setTick] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  // Mutable mirrors for event handlers.
  const r = useRef({ pos: 0, dur: 0, paused: false, ui: true, preview: null as number | null, sess: null as Session | null, lastInput: performance.now(), exiting: false, started: false, scrubTimer: 0 as number | undefined, osdTimer: 0 as number | undefined, keepMode: false });
  const seekTarget = useRef<number | null>(null);
  r.current.pos = pos;
  r.current.dur = dur;
  r.current.ui = ui;
  r.current.preview = preview;
  r.current.sess = sess;
  r.current.paused = state === 'Paused';
  const panelOpen = useRef(false);
  panelOpen.current = showEps;

  // html.starting -> opaque page keeps the backdrop + "Starting…" until the first frame;
  // html.playing  -> transparent page so the native video shows through.
  useEffect(() => {
    const h = document.documentElement.classList;
    h.toggle('starting', starting);
    h.toggle('playing', !starting);
  }, [starting]);
  useEffect(() => () => document.documentElement.classList.remove('playing', 'starting'), []);
  useEffect(() => {
    if (!starting) return setWakeHint(false);
    const t = window.setTimeout(() => setWakeHint(true), WAKE_HINT_MS);
    return () => window.clearTimeout(t);
  }, [starting]);
  const firstFrame = () => {
    if (marks.current.playing !== undefined) return;
    mark('playing');
    setStarting(false);
    const m = marks.current;
    log('startup timing', { item: m.item, playbackInfo: m.pbi, playSent: m.play, firstPlaying: m.playing, itemCached: m.cached === 0, speculative: m.spec === 0 });
  };

  // ---------- start ----------
  function errorText(code?: string, msg?: string) {
    const map: Record<string, string> = {
      openFailed: 'The stream could not be opened.',
      mediaFailed: 'Playback failed.',
      videoCodecUnsupported: 'This video codec is not supported on this console.',
      badAudioTrack: 'This audio track cannot be played.',
    };
    return (code && map[code] ? map[code] + ' ' : '') + (msg ? `(${msg})` : code ? `(${code})` : 'Playback error');
  }

  type Pbi = Awaited<ReturnType<typeof getPlaybackInfo>>;
  async function start(item: Item, startMs: number, audioIndex: number | undefined, subIndex: number, forceTranscode = false, pre?: Pbi | null) {
    setErr(null);
    setState('Opening');
    try {
      const { r: info, src } = pre ?? (await getPlaybackInfo(item, { startMs, audioIndex, subIndex, forceTranscode }));
      mark('pbi');
      const { url, method } = streamUrl(item, src, info.PlaySessionId);
      const s: Session = { item, source: src, playSessionId: info.PlaySessionId, playMethod: method, url, audioIndex, subIndex, startMs };
      log('play session', { item: item.Name, method, container: src.Container, startMs, audioIndex, subIndex, transcodeReason: src.TranscodingUrl ? /TranscodeReasons=([^&]+)/.exec(src.TranscodingUrl)?.[1] : undefined });
      setSess(s);
      r.current.sess = s;
      send({ type: 'play', ...buildPlayMsg(s) });
      mark('play');
      reportStart(s, startMs);
      r.current.started = true;
      loadSubs(s, subIndex);
    } catch (e: any) {
      log('play failed', String(e?.message ?? e));
      setErr(String(e?.message ?? e));
    }
  }

  async function loadSubs(s: Session, subIndex: number, bust = false) {
    setCues([]);
    if (subIndex < 0) return;
    const st = s.source.MediaStreams.find((m) => m.Index === subIndex && m.Type === 'Subtitle');
    if (!st) return;
    if (!st.IsTextSubtitleStream) return; // image subs are burned in by the transcode
    try {
      const u = subtitleUrl(s, st);
      const c = await loadVtt(bust ? u + (u.includes('?') ? '&' : '?') + '_=' + Date.now() : u);
      setCues(c);
      log('subs loaded', st.Language, c.length, 'cues');
    } catch (e) {
      log('subs failed', String(e));
      flash('Subtitles unavailable');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Everything that only needs the id starts at once, in parallel: item, segments, and — when the item
        // isn't cached — a speculative PlaybackInfo with server-default tracks (used as-is when it matches our picks).
        const segP = mediaSegments(id);
        const cached = cachedItem(id);
        mark(cached ? 'cached' : 'fetch');
        let specP: Promise<Pbi | null> | null = null;
        // Direct-play URLs don't depend on start position or tracks (native seeks / selects the track itself).
        if (!cached) specP = getPlaybackInfo({ Id: id } as Item, { startMs: 0, audioIndex: undefined, subIndex: -1 }).catch(() => null);
        const item = cached ?? (await getItem(id));
        mark('item');
        if (cancelled) return;
        setIt(item);
        const bd = backdropUrl(item);
        if (bd) setBackdrop(bd, 0.55, 0);
        const resumeMs = (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_MS;
        const startMs = fromStart ? 0 : startOverride ?? resumeMs;
        const t = pickTracks(item);
        setPos(startMs);
        setDur((item.RunTimeTicks ?? 0) / TICKS_PER_MS);
        let pre: Pbi | null = null;
        if (specP) {
          const sp = await specP;
          // Reusable when direct play (audio/subs are picked natively / drawn by us) and no image-sub burn-in is needed.
          const sub = item.MediaSources?.[0]?.MediaStreams.find((m) => m.Index === t.sub);
          if (sp && sp.src.SupportsDirectPlay && !(sub && !sub.IsTextSubtitleStream)) {
            pre = sp;
            mark('spec');
          }
        }
        if (cancelled) return;
        start(item, startMs, t.audio, t.sub, false, pre);
        segP.then((s) => !cancelled && setSegments(s));
        if (item.Type === 'Episode') nextEpisodeAfter(item).then((n) => !cancelled && setNext(n)).catch(() => {});
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ---------- native events ----------
  useEffect(
    () =>
      onNative((m: any) => {
        switch (m.type) {
          case 'time':
            if (r.current.preview === null) setPos(m.positionMs);
            if (m.durationMs > 0) setDur(m.durationMs);
            if (m.bufferedMs !== undefined) setBuf(m.bufferedMs);
            if (seekTarget.current !== null && m.positionMs > seekTarget.current + 300) {
              seekTarget.current = null;
              setState((s) => (s === 'Buffering' ? 'Playing' : s));
            }
            break;
          case 'playbackState':
            setState(m.state);
            if (m.state === 'Playing' || m.state === 'Paused') firstFrame();
            if (m.videoWidth && m.videoHeight) setVideoSize(`${m.videoWidth}×${m.videoHeight}`);
            if (m.state === 'Stopped' && typeof m.positionMs === 'number') r.current.pos = m.positionMs;
            break;
          case 'tracks':
            setNativeTracks(m.audio ?? []);
            break;
          case 'decoder':
            setDecoder(m.summary ?? m.path);
            break;
          case 'error':
            if (m.code === 'videoCodecSlow') flash('Software decoding — playback may stutter', 4000);
            else if (m.code === 'mfOpenFailed' || m.code === 'mfFailed') log('native fallback', m.code);
            else if (m.fatal) setErr(errorText(m.code, m.message));
            else flash(m.message || m.code);
            break;
          case 'playbackEnded':
            onEnded();
            break;
        }
      }),
    [next],
  );

  // ---------- progress reporting ----------
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = r.current.sess;
      if (s && r.current.started) reportProgress(s, r.current.pos, r.current.paused);
    }, PROGRESS_MS);
    return () => window.clearInterval(t);
  }, []);

  // Stop + report on unmount (route popped any way). Native answers `stop` with playbackState Stopped{positionMs};
  // wait briefly for it so the final resume point is exact, else fall back to the last `time` position.
  useEffect(
    () => () => {
      const s = r.current.sess;
      const fallback = r.current.pos;
      // Leaving for the UI: native restores the TV's default refresh rate at once. Episode switches (keepMode) keep
      // the movie mode so the next episode starts without another HDMI blank.
      const stopMsg = r.current.keepMode ? { type: 'stop' } : { type: 'stop', restore: 'now' };
      if (!s || !r.current.started) {
        send(stopMsg);
        return;
      }
      let done = false;
      const finish = (ms: number) => {
        if (done) return;
        done = true;
        off();
        window.clearTimeout(t);
        reportStopped(s, ms);
      };
      const off = onNative((m: any) => {
        if (m.type === 'playbackState' && m.state === 'Stopped') finish(typeof m.positionMs === 'number' && m.positionMs > 0 ? m.positionMs : fallback);
      });
      const t = window.setTimeout(() => finish(fallback), 1500);
      send(stopMsg);
    },
    [],
  );

  // ---------- overlay auto-hide ----------
  useEffect(() => {
    const t = window.setInterval(() => {
      setTick((n) => n + 1); // clock
      const c = r.current;
      if (c.ui && !c.paused && !dialog.value && !finder.value && !subTask && !panelOpen.current && c.preview === null && performance.now() - c.lastInput > HIDE_MS && state === 'Playing') {
        setUi(false);
        setShowInfo(false);
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [state, subTask]);

  function showUi(focusSel?: string) {
    r.current.lastInput = performance.now();
    if (!r.current.ui) setUi(true);
    requestAnimationFrame(() => {
      if (dialog.value || finder.value || stillWatching.value) return; // a dialog/panel opened in the same tick owns focus
      const el = focusSel ? root.current?.querySelector<HTMLElement>(focusSel) : null;
      const cur = current();
      if (el) focusEl(el);
      else if (!cur || !root.current?.contains(cur)) focusEl(root.current?.querySelector<HTMLElement>('.pp-play'));
    });
  }

  function flash(text: string, ms = 1200) {
    setOsd(text);
    window.clearTimeout(r.current.osdTimer);
    r.current.osdTimer = window.setTimeout(() => setOsd(null), ms);
  }

  // ---------- transport ----------
  const togglePause = () => {
    if (r.current.paused) {
      send({ type: 'resume' });
      setState('Playing');
      flash('@play');
    } else {
      send({ type: 'pause' });
      setState('Paused'); // the centre indicator (.p-paused) shows the pause state itself
    }
    const s = r.current.sess;
    if (s) reportProgress(s, r.current.pos, !r.current.paused, r.current.paused ? 'Unpause' : 'Pause');
  };

  const seekTo = (ms: number) => {
    const d = r.current.dur || Infinity;
    const target = Math.max(0, Math.min(d - 1000, ms));
    send({ type: 'seek', positionMs: Math.round(target) });
    setPos(target);
    r.current.pos = target;
    // HLS transcodes restart server-side on seek (~8 s on Xbox): show the spinner until native reports Playing.
    if (r.current.sess && r.current.sess.playMethod !== 'DirectPlay' && !r.current.paused) {
      seekTarget.current = target;
      setState('Buffering');
    }
  };

  const commitPreview = () => {
    window.clearTimeout(r.current.scrubTimer);
    const p = r.current.preview;
    if (p === null) return;
    setPreview(null);
    r.current.preview = null;
    seekTo(p);
  };
  const cancelPreview = () => {
    window.clearTimeout(r.current.scrubTimer);
    setPreview(null);
    r.current.preview = null;
  };

  /** Scrub preview: accumulate steps, commit after idle or on release. */
  const scrub = (deltaMs: number, idleCommitMs = 650) => {
    const base = r.current.preview ?? r.current.pos;
    const d = r.current.dur || Infinity;
    const p = Math.max(0, Math.min(d - 1000, base + deltaMs));
    setPreview(p);
    r.current.preview = p;
    window.clearTimeout(r.current.scrubTimer);
    if (idleCommitMs > 0) r.current.scrubTimer = window.setTimeout(commitPreview, idleCommitMs);
  };

  const stepFor = (e: ActionEvent, kind: 'dpad' | 'trigger') => {
    const h = e.heldMs;
    if (kind === 'dpad') return h < 1000 ? 10_000 : h < 3000 ? 30_000 : 120_000;
    return h < 1000 ? 30_000 : h < 3000 ? 60_000 : 180_000;
  };

  const chapters = it?.Chapters ?? [];
  const chapterJump = (dir: 1 | -1) => {
    const p = r.current.preview ?? r.current.pos;
    if (chapters.length > 1) {
      const starts = chapters.map((c) => c.StartPositionTicks / TICKS_PER_MS);
      let target: number | undefined;
      if (dir > 0) target = starts.find((s) => s > p + 1000);
      else {
        const prev = starts.filter((s) => s < p - 3000);
        target = prev.length ? prev[prev.length - 1] : 0;
      }
      if (target === undefined) return flash('Last chapter');
      const ch = chapters[starts.indexOf(target)];
      seekTo(target);
      flash(ch?.Name && !/^chapter \d+$/i.test(ch.Name) ? ch.Name : `Chapter ${starts.indexOf(target) + 1}`, 1600);
    } else {
      seekTo(p + dir * 600_000);
      flash(dir > 0 ? '+10 min' : '−10 min');
    }
  };

  const exit = () => {
    if (r.current.exiting) return;
    r.current.exiting = true;
    pop(); // unmount sends stop + reports position
  };

  /** Autoplay into the next episode (file end, or the credits countdown while the credits still play). */
  const advance = (n: Item, early = false) => {
    if (!sw.holdNext(() => playNext(n), n)) return playNext(n);
    if (early && !r.current.paused) togglePause(); // idle too long: "Are you still watching?" instead; don't run the credits under it
  };
  const onEnded = () => {
    const n = next;
    if (n && !r.current.exiting && nextAutoplayMode() !== 0) advance(n); // Settings → Next episode autoplay Off: just leave
    else exit();
  };

  /** Switch to another episode from the Episodes panel (it resumes where that episode was left). */
  const switchEpisode = (n: Item) => {
    const s = r.current.sess;
    if (s && r.current.started) reportStopped(s, r.current.pos);
    r.current.started = false;
    r.current.keepMode = true;
    send({ type: 'stop' });
    setShowEps(false);
    replaceTop({ name: 'player', id: n.Id });
  };

  const playNext = (n: Item) => {
    noteFinished(it);
    const s = r.current.sess;
    if (s) reportStopped(s, r.current.dur || r.current.pos);
    r.current.started = false; // already reported
    r.current.keepMode = true;
    send({ type: 'stop' });
    replaceTop({ name: 'player', id: n.Id, fromStart: true });
  };

  /** Credits shelf pick: the film is done, so report it at its end (counts as watched), then play the pick or open its page. */
  const openFromShelf = (n: Item, details: boolean) => {
    if (r.current.exiting) return;
    r.current.exiting = true;
    const s = r.current.sess;
    if (s && r.current.started) reportStopped(s, r.current.dur || r.current.pos);
    r.current.started = false; // already reported
    if (details || n.Type !== 'Movie') {
      send({ type: 'stop', restore: 'now' }); // back to the UI: default refresh rate at once
      replaceTop({ name: 'item', id: n.Id });
    } else {
      r.current.keepMode = true; // film to film: keep the movie display mode
      send({ type: 'stop' });
      replaceTop({ name: 'player', id: n.Id });
    }
  };

  /** Credits shelf pick of a title not in the library: the film is done; leave the player for its TMDB page (request it there). */
  const openTmdbFromShelf = (t: SItem) => {
    if (r.current.exiting || (t.mediaType !== 'movie' && t.mediaType !== 'tv')) return;
    r.current.exiting = true;
    const s = r.current.sess;
    if (s && r.current.started) reportStopped(s, r.current.dur || r.current.pos);
    r.current.started = false;
    send({ type: 'stop', restore: 'now' });
    replaceTop({ name: 'tmdb', type: t.mediaType, id: t.id });
  };

  // ---------- segments / next ----------
  const activeSeg = segments.find((s) => ['Intro', 'Recap', 'Preview'].includes(s.Type) && pos >= s.StartTicks / TICKS_PER_MS && pos < s.EndTicks / TICKS_PER_MS - 1500);
  // Card at a plausible Outro start, else 40 s before the end (lib/introskip.ts). Segments are file times: measure against the item's
  // runtime (an HLS transcode can report ~20 s more than the file).
  const nextT = nextTiming(segments, (it?.RunTimeTicks ?? 0) / TICKS_PER_MS || dur);
  const showNext = !!next && !nextDismissed && dur > 0 && pos >= nextT.cardAt && pos < dur;
  const skipSeg = () => {
    if (!activeSeg) return;
    autoSkip.manualSkip(activeSeg);
    seekTo(segEnd(activeSeg));
  };
  const sw = useStillWatching({
    item: it, durMs: dur, posMs: pos, playing: state === 'Playing', credits: showNext, closePanels: () => setShowEps(false), exit,
    pause: () => !r.current.paused && togglePause(),
    resume: () => (r.current.paused && togglePause(), showUi()),
  });
  const autoSkip = useAutoSkip({ item: it, segments, pos, playing: state === 'Playing', seekTo });
  const countdown = useNextCountdown({
    visible: showNext && !activeSeg, clean: nextT.clean, playing: state === 'Playing',
    blocked: () => !!(dialog.value || finder.value || panelOpen.current || stillWatching.value),
    advance: () => next && !r.current.exiting && advance(next, true),
  });
  const cdRef = useRef(countdown);
  cdRef.current = countdown;
  // Movies: "More Like This" shelf at the end credits (components/CreditsShelf.tsx, lib/upnext-movie.ts).
  const shelf = useCreditsShelf({
    item: it, segments, runtimeMs: (it?.RunTimeTicks ?? 0) / TICKS_PER_MS || dur, posMs: pos, root,
    suppressed: !!activeSeg || (!ui && preview !== null),
    open: (n, details) => openFromShelf(n, details),
    openTmdb: (t) => openTmdbFromShelf(t),
  });
  const shelfRef = useRef(shelf);
  shelfRef.current = shelf;
  useEffect(() => {
    if (showNext) noteFinished(it); // credits reached: the next episode of this series counts as bingeing (recap auto-skip)
  }, [showNext]);

  // When the skip / next card appears with the overlay hidden, it takes focus (single A skips).
  useEffect(() => {
    const sel = activeSeg ? '.skip-btn' : showNext ? '.next-card .btn' : autoSkip.showingUndo ? '.as-undo .btn' : '';
    if (!ui && sel) requestAnimationFrame(() => !stillWatching.value && focusEl(root.current?.querySelector<HTMLElement>(sel)));
  }, [!!activeSeg, showNext, autoSkip.showingUndo, ui]);

  // ---------- tracks picker ----------
  const audios: MediaStream[] = sess?.source.MediaStreams.filter((m) => m.Type === 'Audio') ?? [];
  const subs: MediaStream[] = sess?.source.MediaStreams.filter((m) => m.Type === 'Subtitle') ?? [];

  const setAudio = (index: number) => {
    const s = r.current.sess;
    if (!s || !it) return;
    rememberAudio(it, s.source.MediaStreams, index);
    const ordinal = audios.findIndex((a) => a.Index === index);
    if (s.playMethod === 'DirectPlay' && nativeTracks.length === audios.length && ordinal >= 0) {
      send({ type: 'setAudioTrack', index: ordinal });
      setSess({ ...s, audioIndex: index });
    } else {
      // Transcoded stream carries one audio track: restart the session with the new track.
      reportStopped(s, r.current.pos);
      start(it, r.current.pos, index, s.subIndex);
    }
  };
  const setSub = (index: number, remember = true) => {
    const s = r.current.sess;
    if (!s || !it) return;
    if (remember) rememberSub(it, s.source.MediaStreams, index);
    const st = subs.find((x) => x.Index === index);
    if (index >= 0 && st && !st.IsTextSubtitleStream) {
      // image subtitles need a burn-in transcode
      reportStopped(s, r.current.pos);
      start(it, r.current.pos, s.audioIndex, index, true);
      return;
    }
    const ns = { ...s, subIndex: index };
    setSess(ns);
    loadSubs(ns, index);
  };
  // ---------- subtitle tools (Bazarr via the page server) ----------
  const loadSubInfo = () => {
    if (!it) return;
    itemSubs(it.Id)
      .then((x) => (subInfo.current = x))
      .catch((e) => log('subs info failed', String(e?.message ?? e)));
  };
  useEffect(() => {
    if (sess && !subInfo.current) loadSubInfo();
  }, [!!sess]);

  /** Re-read the item's streams from Jellyfin (after a download/delete) without restarting playback. */
  const refreshStreams = async (selectIndex?: number | null, fileName?: string) => {
    const s = r.current.sess;
    if (!s || !it) return;
    let fresh = (await getItem(it.Id)).MediaSources?.[0]?.MediaStreams;
    // Jellyfin may need a moment to list a new external file: retry briefly.
    for (let i = 0; i < 5 && fresh && fileName && !fresh.some((m) => m.Type === 'Subtitle' && m.IsExternal && (m.Path ?? '').endsWith(fileName)); i++) {
      await new Promise((res) => setTimeout(res, 1500));
      fresh = (await getItem(it.Id)).MediaSources?.[0]?.MediaStreams;
    }
    if (!fresh) return;
    if (fileName && (selectIndex === null || selectIndex === undefined)) selectIndex = fresh.find((m) => m.Type === 'Subtitle' && (m.Path ?? '').endsWith(fileName))?.Index;
    const cur = r.current.sess ?? s;
    // Stream indexes can shift when an external file is added: carry the audio choice over by ordinal.
    const oldAud = cur.source.MediaStreams.filter((m) => m.Type === 'Audio');
    const newAud = fresh.filter((m) => m.Type === 'Audio');
    const ord = oldAud.findIndex((m) => m.Index === cur.audioIndex);
    const audioIndex = ord >= 0 && newAud[ord] ? newAud[ord].Index : cur.audioIndex;
    const ns: Session = { ...cur, audioIndex, source: { ...cur.source, MediaStreams: fresh } };
    setSess(ns);
    r.current.sess = ns;
    if (selectIndex !== null && selectIndex !== undefined) {
      const st = fresh.find((m) => m.Index === selectIndex && m.Type === 'Subtitle');
      if (st) {
        rememberSub(it, fresh, selectIndex);
        const ns2 = { ...ns, subIndex: selectIndex };
        setSess(ns2);
        r.current.sess = ns2;
        loadSubs(ns2, selectIndex, true);
        flash(subLabel(st) + ' · on', 1800);
      }
    }
    loadSubInfo();
  };

  const findSubs = () => {
    if (!it) return;
    const wasPaused = r.current.paused;
    if (!wasPaused) togglePause(); // pause while browsing; resumed after a download
    openFinder({
      item: it,
      onDownloaded: (idx, fileName) => {
        refreshStreams(idx, fileName).finally(() => {
          if (!wasPaused && r.current.paused) togglePause();
          showUi();
        });
      },
      onClose: () => showUi(),
    });
  };

  const syncCurrent = async (index: number) => {
    if (!it || subTask) return;
    setSubTask('Syncing subtitles to the audio…');
    showUi();
    try {
      const s0 = r.current.sess;
      const audOrd = Math.max(0, audios.findIndex((a) => a.Index === s0?.audioIndex));
      const res = await syncSub(it.Id, index, audOrd);
      log('subs synced', { item: it.Name, file: res.fileName, offset: res.offsetSeconds, scale: res.framerateScale, ref: res.reference, backup: res.backup, cut: res.cut });
      if (subOffset(it.Id)) {
        setSubOffset(it.Id, 0);
        setSubOff(0);
      }
      const s = r.current.sess;
      if (s && s.subIndex === index) loadSubs(s, index, true);
      const off = res.offsetSeconds;
      const noFix = off === 0 && (res.framerateScale ?? 1) === 1;
      if (res.cut?.likelyOtherCut) {
        // The subtitle runs minutes past the end of the video: no offset can fix that.
        setSubTask(null);
        openSyncAdvice(
          'These subtitles are for a different cut',
          `They run to ${fmtMin(res.cut.subtitleEndSeconds)}, but this video is ${fmtMin(res.cut.videoSeconds)} long. Find subtitles made for this release (match the runtime), or adjust by hand.`,
          index,
        );
      } else if (noFix || off === null) {
        setSubTask(null);
        openSyncAdvice('No offset found', 'The subtitle may be for a different cut or release. Try Find subtitles…, or move it by hand.', index);
      } else {
        showToast(`Subtitles re-timed (moved ${Math.abs(off).toFixed(2)} s ${off > 0 ? 'later' : 'earlier'})`, 4000);
      }
    } catch (e: any) {
      log('subs sync failed', String(e?.message ?? e));
      showToast('Sync failed: ' + String(e?.message ?? e), 4500);
    } finally {
      setSubTask(null);
    }
  };

  /** Sync couldn't help: say so plainly and offer the manual paths (Find subtitles… / ±0.5 s) right there. */
  const openSyncAdvice = (title: string, note: string, index: number) => {
    if (!it) return;
    const opts: Opt[] = [
      { label: 'Find subtitles…', value: 'find', action: true, icon: 'findSubs' },
      { label: 'Show earlier', value: 'earlier', action: true, keep: true, sub: '−0.5 s', icon: 'chevLeft' },
      { label: 'Show later', value: 'later', action: true, keep: true, sub: '+0.5 s', icon: 'chevRight' },
      { label: 'Reset timing', value: 'reset', action: true, keep: true, sub: fmtOffset(subOffset(it.Id)), icon: 'undo' },
      { label: 'Close', value: 'close', action: true, icon: 'close' },
    ];
    log('subs sync advice', { title, index });
    openPicker([
      {
        title,
        note,
        options: opts,
        onPick: (v) => {
          if (v === 'find') return findSubs();
          if (v === 'earlier' || v === 'later' || v === 'reset') {
            const nv = nudge(v === 'earlier' ? -500 : v === 'later' ? 500 : 0) ?? 0;
            const row = opts.find((o) => o.value === 'reset');
            if (row) row.sub = fmtOffset(nv);
          }
        },
      },
    ]);
  };

  const removeOurs = async (index: number) => {
    if (!it || subTask) return;
    setSubTask('Removing subtitle…');
    try {
      const res = await deleteSub(it.Id, index);
      log('subs deleted', res.deleted);
      setSub(-1, false); // not a choice: don't turn subtitles off for the whole series
      await refreshStreams(null);
      showToast('Subtitle removed', 2500);
    } catch (e: any) {
      showToast('Remove failed: ' + String(e?.message ?? e), 4000);
    } finally {
      setSubTask(null);
    }
  };

  const nudge = (deltaMs: number) => {
    if (!it) return;
    const v = deltaMs === 0 ? 0 : Math.max(-60_000, Math.min(60_000, subOffset(it.Id) + deltaMs));
    setSubOffset(it.Id, v);
    setSubOff(v);
    return v;
  };

  const openTracksRef = useRef<(focusValue?: string) => void>(() => {});
  const openTracks = (focusValue?: string) => {
    if (!sess) return;
    showUi();
    const curSub = subs.find((x) => x.Index === sess.subIndex);
    const info = subInfo.current;
    const ours = curSub?.Path && info?.subtitles.some((x) => x.ours && x.path === curSub.Path);
    const manage = info ? info.canManage : caps.value?.subtitleTools ?? true;
    const subOpts: Opt[] = [
      { label: 'Off', value: '-1', selected: sess.subIndex < 0 },
      ...subs.map((x) => ({ label: subLabel(x), value: String(x.Index), sub: x.IsTextSubtitleStream ? (x.IsExternal ? 'External' : undefined) : 'burn-in', selected: x.Index === sess.subIndex })),
    ];
    if (manage) subOpts.push({ label: 'Find subtitles…', value: 'find', action: true, icon: 'findSubs' });
    if (manage && curSub?.IsExternal) {
      const cut = info?.subtitles.find((x) => x.path === curSub.Path)?.cut;
      subOpts.push({ label: 'Fix timing (sync to audio)', value: 'sync', action: true, icon: 'fixTiming', sub: subTask ? 'busy' : cut?.likelyOtherCut ? 'made for another cut' : undefined });
    }
    if (sess.subIndex >= 0 && curSub?.IsTextSubtitleStream) {
      const off = subOffset(it!.Id);
      subOpts.push({ label: 'Show earlier', value: 'earlier', action: true, keep: true, sub: '−0.5 s', icon: 'chevLeft' });
      subOpts.push({ label: 'Show later', value: 'later', action: true, keep: true, sub: '+0.5 s', icon: 'chevRight' });
      subOpts.push({ label: 'Reset timing', value: 'reset', action: true, keep: true, sub: fmtOffset(off), icon: 'undo' });
    }
    if (manage && ours) subOpts.push({ label: 'Remove this download', value: 'remove', action: true, icon: 'trash' });
    const timingRow = () => subOpts.find((o) => o.value === 'reset');
    // Audio boost / Night mode rows (cycle in place, remembered per user, applied live: lib/audioboost.ts).
    const audioOpts: Opt[] = audios.map((a) => ({ label: audioLabel(a), value: String(a.Index), selected: a.Index === sess.audioIndex }));
    const boostOk = boostAvailable();
    audioOpts.push({ label: 'Audio boost', value: 'boost', action: true, keep: true, icon: 'boost', sub: boostOk ? '' : 'Not available on this browser' });
    if (boostOk) audioOpts.push({ label: 'Night mode', value: 'night', action: true, keep: true, icon: 'night', sub: '' });
    const boostRows = () => {
      const b = audioOpts.find((o) => o.value === 'boost');
      const n = audioOpts.find((o) => o.value === 'night');
      if (b && boostOk) b.sub = boostLabel(audioBoost.value.db) + (boostAck.value && !boostAck.value.applied ? ' · ' + (boostAck.value.reason ?? 'not applied') : '');
      if (n) n.sub = audioBoost.value.night ? 'On' : 'Off';
    };
    boostRows();
    openPicker(
      [
        {
          title: 'Audio',
          icon: 'audio',
          options: audioOpts,
          onPick: (v) => {
            if (v === 'boost' || v === 'night') {
              if (v === 'boost') setBoost({ db: BOOST_STEPS[(BOOST_STEPS.indexOf(audioBoost.value.db) + 1) % BOOST_STEPS.length] });
              else setBoost({ night: !audioBoost.value.night });
              boostRows();
              flash(v === 'boost' ? 'Audio boost ' + boostLabel(audioBoost.value.db) : 'Night mode ' + (audioBoost.value.night ? 'on' : 'off'));
              return;
            }
            setAudio(+v);
          },
        },
        {
          title: 'Subtitles',
          icon: 'subtitles',
          options: subOpts,
          onPick: (v) => {
            if (v === 'find') return findSubs();
            if (v === 'sync') return curSub && syncCurrent(curSub.Index);
            if (v === 'remove') return curSub && removeOurs(curSub.Index);
            if (v === 'earlier' || v === 'later' || v === 'reset') {
              const nv = nudge(v === 'earlier' ? -500 : v === 'later' ? 500 : 0) ?? 0;
              const row = timingRow();
              if (row) row.sub = fmtOffset(nv);
              return;
            }
            setSub(+v);
            // Rebuild so the per-track rows (Fix timing, offset) match the new selection; keep focus on the pick.
            window.setTimeout(() => dialog.value && openTracksRef.current(v), 60);
          },
        },
      ],
      false,
    );
    if (focusValue) requestAnimationFrame(() => requestAnimationFrame(() => focusEl(document.querySelector<HTMLElement>(`.dialog [data-fkey="opt-${focusValue}"]`))));
  };
  openTracksRef.current = openTracks;
  // ---------- HDR -> SDR picture (server tone-mapping brightness/contrast) ----------
  useEffect(() => {
    loadPicture();
  }, []);
  const srcRange = sess?.source.MediaStreams.find((m) => m.Type === 'Video')?.VideoRangeType;
  const toneMapped = !!sess && settings.value.hdr === 'off' && !!srcRange && srcRange !== 'SDR' && sess.playMethod !== 'DirectPlay';
  const restartForPicture = () => {
    // Jellyfin reads the values when a transcode starts: restart the stream at the current position.
    const s = r.current.sess;
    if (!s || !it) return;
    reportStopped(s, r.current.pos);
    start(it, r.current.pos, s.audioIndex, s.subIndex);
  };
  const openPicture = () => {
    showUi();
    openPictureDialog(restartForPicture);
  };
  const centerIcon: 'pause' | 'play' | null = state === 'Paused' ? 'pause' : osd === '@play' ? 'play' : null;
  const lastCenter = useRef<'pause' | 'play'>('pause');
  if (centerIcon) lastCenter.current = centerIcon; // keep the glyph while it fades out
  const lastSub = useRef<number>(-1);
  const toggleSubs = () => {
    const s = r.current.sess;
    if (!s) return;
    if (s.subIndex >= 0) {
      lastSub.current = s.subIndex;
      setSub(-1);
      flash('Subtitles off');
    } else {
      const want = lastSub.current >= 0 ? lastSub.current : subs.find((x) => x.IsTextSubtitleStream)?.Index;
      if (want === undefined) return flash('No subtitles');
      setSub(want);
      flash('Subtitles on');
    }
  };

  // ---------- input ----------
  useEffect(() => {
    const scrubKeys: Action[] = ['left', 'right', 'lt', 'rt'];
    const offRelease = onRelease((a) => {
      if (scrubKeys.includes(a) && r.current.preview !== null && !seekFocused()) commitPreview();
    });
    const seekFocused = () => current()?.classList.contains('seek') ?? false;
    const off = pushHandler((e) => {
      if (dialog.value || finder.value || panelOpen.current || stillWatching.value) return false; // dialog / finder / episodes panel / still-watching handle themselves
      const c = r.current;
      c.lastInput = performance.now();
      const a = e.action;
      if (a !== 'select' && cdRef.current.counting) cdRef.current.cancel(); // touching anything but A stops the Next countdown
      if (err) {
        if (a === 'back') {
          exit();
          return true;
        }
        if (['up', 'down', 'left', 'right', 'select'].includes(a)) return false; // error buttons
        return true;
      }
      // hold B = exit from any state
      if (a === 'back' && e.repeat && e.heldMs > 600) {
        exit();
        return true;
      }
      if (a === 'back' && e.repeat) return true;
      if (shelfRef.current.handle(e, c.ui)) return true; // credits shelf: Down/Up in and out, A/X/B on its cards

      // Shortcuts live in every state.
      switch (a) {
        case 'lb':
        case 'rb':
          if (!e.repeat) chapterJump(a === 'rb' ? 1 : -1);
          return true;
        case 'lt':
        case 'rt':
          scrub((a === 'rt' ? 1 : -1) * stepFor(e, 'trigger'));
          if (!c.ui) setUi(true);
          return true;
        case 'x':
          if (!e.repeat) openTracks();
          return true;
        case 'y':
          if (!e.repeat) toggleSubs();
          return true;
        case 'menu':
        case 'view':
          if (!e.repeat) c.ui ? setUi(false) : showUi();
          return true;
      }

      if (!c.ui) {
        // Overlay hidden.
        const focusedPrompt = current();
        const promptFocused = focusedPrompt && (focusedPrompt.classList.contains('skip-btn') || focusedPrompt.closest('.next-card, .as-undo'));
        switch (a) {
          case 'select':
            if (promptFocused && !e.repeat) {
              focusedPrompt!.click();
              return true;
            }
            if (!e.repeat) {
              togglePause();
              showUi();
            }
            return true;
          case 'back':
            if (showNext) {
              setNextDismissed(true);
              return true;
            }
            exit();
            return true;
          case 'left':
          case 'right':
            scrub((a === 'right' ? 1 : -1) * stepFor(e, 'dpad'), e.source === 'key' ? 650 : 650);
            return true;
          case 'up':
            showUi('.seek');
            return true;
          case 'down':
            showUi('.pp-play');
            return true;
        }
        return true;
      }

      // Overlay visible.
      if (seekFocused()) {
        if (a === 'left' || a === 'right') {
          scrub((a === 'right' ? 1 : -1) * stepFor(e, 'dpad'), 0);
          return true;
        }
        if (a === 'select') {
          if (c.preview !== null) commitPreview();
          else togglePause();
          return true;
        }
        if (a === 'back' && c.preview !== null) {
          cancelPreview();
          return true;
        }
        if ((a === 'up' || a === 'down') && c.preview !== null) commitPreview();
      }
      if (a === 'back') {
        if (showInfo) {
          setShowInfo(false);
          return true;
        }
        setUi(false);
        setShowInfo(false);
        (document.activeElement as HTMLElement)?.blur?.();
        return true;
      }
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
        move(a);
        return true;
      }
      return false; // select -> global click
    });
    return () => {
      off();
      offRelease();
    };
  }, [err, it, sess, nativeTracks, next, showNext, segments, dur, showInfo]);

  // Desktop keyboard: Space = play/pause, ←/→ = ±10 s (overlay buttons are for the mouse here), F = fullscreen.
  useEffect(() => {
    if (isNative || isAndroidTV) return; // TV remote D-pad arrows must navigate the overlay, not seek
    const onKey = (e: KeyboardEvent) => {
      if (dialog.value || finder.value || panelOpen.current || stillWatching.value || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          r.current.lastInput = performance.now();
          togglePause();
        }
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !current()?.closest('.seek, .cshelf')) {
        e.preventDefault();
        e.stopPropagation();
        r.current.lastInput = performance.now();
        const d = e.key === 'ArrowRight' ? 10_000 : -10_000;
        seekTo((r.current.preview ?? r.current.pos) + d);
        flash(d > 0 ? '+10 s' : '−10 s', 700);
      } else if (e.key === 'f' && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Initial overlay focus, and re-focus whenever the overlay (re)appears or controls finish loading.
  useEffect(() => {
    if (ui) showUi();
  }, []);
  useEffect(() => {
    if (!ui) return;
    const t = requestAnimationFrame(() => {
      if (dialog.value || finder.value || stillWatching.value) return;
      const cur = current();
      if (!cur || !root.current?.contains(cur)) focusEl(root.current?.querySelector<HTMLElement>('.pp-play, .p-error .btn'));
    });
    return () => cancelAnimationFrame(t);
  }, [ui, !!sess, state === 'Playing' || state === 'Paused']);

  // ---------- render ----------
  const shown = preview ?? pos;
  const pct = dur > 0 ? Math.min(1, shown / dur) : 0;
  const bpct = dur > 0 ? Math.min(1, buf / dur) : 0;
  const remaining = Math.max(0, dur - shown);
  const endsAtLabel = endsAt(remaining);
  const subsNow = useMemo(() => cuesAt(cues, pos - subOff), [cues, Math.floor(pos / 100), subOff]);
  const loading = !err && (state === 'Opening' || state === 'Buffering' || !sess);
  const title = it ? (it.Type === 'Episode' ? it.SeriesName : it.Name) : '';
  const subtitle = it?.Type === 'Episode' ? `${episodeLabel(it)} · ${it.Name}` : it?.ProductionYear ? String(it.ProductionYear) : '';
  // Phone remote: Now playing panel + lock screen (components/RemotePlayer.ts runs these same handlers).
  useRemotePlayer({
    it, title: title || '', subtitle, paused: state === 'Paused', buffering: loading, pos: () => r.current.pos, dur, audios, subs,
    audioIndex: sess?.audioIndex ?? -1, subIndex: sess?.subIndex ?? -1, subOff, pictureOk: toneMapped && !!picture.value?.canEdit,
    next, seg: activeSeg?.Type ?? null, skipMs: 10_000, togglePause, seekTo, flash, setAudio, setSub, nudge,
    applyPicture: (v) => (showUi(), applyPicture(v, restartForPicture)), playNext, switchEpisode, skipSeg, showUi: () => showUi(),
  });
  const vInfo = sess?.source.MediaStreams.find((m) => m.Type === 'Video');
  const aInfo = sess?.source.MediaStreams.find((m) => m.Index === sess.audioIndex && m.Type === 'Audio');
  const transcodeReasons = sess?.source.TranscodingUrl && sess.playMethod !== 'DirectPlay' ? decodeURIComponent(/TranscodeReasons=([^&]+)/.exec(sess.source.TranscodingUrl)?.[1] ?? '').replace(/,/g, ', ') : '';
  const currentChapter = chapters.length > 1 ? [...chapters].reverse().find((c) => c.StartPositionTicks / TICKS_PER_MS <= shown) : undefined;

  return (
    <div
      class={'player' + (ui ? ' ui' : '') + (starting ? ' starting' : '') + (shelf.visible ? ' cs-on' : '')}
      ref={root}
      data-scope
      onMouseMove={() => {
        r.current.lastInput = performance.now();
        if (!r.current.ui) showUi();
      }}
      onClick={(e) => {
        // click on bare video (overlay hidden) = play/pause
        if (e.target === root.current || (e.target as HTMLElement).classList.contains('player-shade')) togglePause();
      }}
    >
      <div class="player-shade" />
      {uiMode.value === 'mobile' && !starting && !err && (
        <MobilePlayerLayer
          ui={ui}
          paused={state === 'Paused'}
          onToggleUi={() => (r.current.ui ? (setUi(false), setShowInfo(false)) : showUi())}
          onTogglePause={togglePause}
          onSeekBy={(ms) => {
            r.current.lastInput = performance.now();
            seekTo(r.current.pos + ms);
          }}
          onClose={exit}
          onActivity={() => (r.current.lastInput = performance.now())}
        />
      )}
      {/* One centre indicator for both states: pause stays while paused; play flashes briefly on resume. */}
      <div class={'p-paused' + (centerIcon && !err && !starting ? ' on' : '')} aria-hidden="true">
        <Icon name={centerIcon ?? lastCenter.current} fill stroke={0} />
      </div>
      {subsNow.length > 0 && (
        <div class="subs">
          {subsNow.map((c, i) => (
            <div key={i}>
              <span dangerouslySetInnerHTML={{ __html: c.text }} />
            </div>
          ))}
        </div>
      )}
      {starting && !err && (
        <div class="p-start">
          <div class="spinner" />
          <div class="p-start-title">{it ? (it.Type === 'Episode' ? `${it.SeriesName} · ${episodeLabel(it)}` : it.Name) : ''}</div>
          <div class="p-start-label">Starting…</div>
          <div class={'p-start-hint' + (wakeHint ? ' on' : '')}>Waking up the media drive…</div>
        </div>
      )}
      {loading && !starting && (
        <div class="p-status">
          <div class="spinner" />
        </div>
      )}
      {err && (
        <div class="p-status">
          <div class="p-error">
            <b>Can't play this</b>
            {err}
            <div class="btn-row" style={{ justifyContent: 'center', marginTop: '1.4rem' }}>
              <div class="btn focusable" tabIndex={-1} data-autofocus ref={(el) => { if (el && !current()) focusEl(el); }} onClick={() => it && start(it, r.current.pos, sess?.audioIndex, sess?.subIndex ?? -1, true)}>
                Try transcoding
              </div>
              <div class="btn focusable" tabIndex={-1} onClick={exit}>
                Back
              </div>
            </div>
          </div>
        </div>
      )}
      {osd && osd[0] !== '@' && <div class="p-osd">{osd}</div>}
      {subTask && (
        <div class="p-task">
          <span class="spinner" />
          {subTask}
        </div>
      )}

      {activeSeg && (
        <div class="btn skip-btn focusable" tabIndex={-1} onClick={skipSeg}>
          Skip {activeSeg.Type === 'Recap' ? 'Recap' : activeSeg.Type === 'Preview' ? 'Preview' : 'Intro'} <Icon name="chevRight" />
        </div>
      )}
      {!activeSeg && !showNext && autoSkip.undo}
      {shelf.node}
      {showNext && next && !activeSeg && <NextCard next={next} label={nextLabel(countdown, Math.max(0, dur - pos))} progress={countdown.progress} onPlay={() => playNext(next)} />}

      {!ui && preview !== null && (
        <div class="mini-seek">
          <SeekBar pct={pct} bpct={bpct} dur={dur} chapters={chapters} preview={preview} focusable={false} chapterName={currentChapter?.Name} />
        </div>
      )}

      {sw.overlay}
      {showEps && it && <EpisodesPanel ep={it} onPick={switchEpisode} onClose={() => { setShowEps(false); showUi('[data-fkey="p-episodes"]'); }} />}

      <div class="player-ui" onClick={(e) => e.target === e.currentTarget && togglePause()}>
        <div class="p-top">
          <div>
            <div class="p-title">{title}</div>
            {subtitle && <div class="p-sub">{subtitle}</div>}
          </div>
          <div class="p-clock">
            {fmtTime()}
            {dur > 0 && <small>Ends at {endsAtLabel}</small>}
          </div>
        </div>
        <div class="p-bottom">
          <SeekBar
            pct={pct}
            bpct={bpct}
            dur={dur}
            chapters={chapters}
            preview={preview}
            focusable
            chapterName={currentChapter?.Name}
            onScrub={(ms, done) => {
              r.current.lastInput = performance.now();
              setPreview(ms);
              r.current.preview = ms;
              if (done) commitPreview();
            }}
          />
          <div class="p-times">
            <span>{fmtClock(shown)}</span>
            <span>−{fmtClock(remaining)}</span>
          </div>
          <div class="p-controls" data-group="pcontrols">
            <div class="btn icon focusable pp-play" tabIndex={-1} onClick={togglePause} title="Play/Pause">
              <Icon name={state === 'Paused' ? 'play' : 'pause'} fill />
            </div>
            {(audios.length > 1 || subs.length > 0 || boostAvailable()) && (
              <div
                class={'btn icon focusable p-tracks' + ((sess?.subIndex ?? -1) >= 0 ? ' subs-on' : '')}
                tabIndex={-1}
                data-fkey="p-tracks"
                title={(sess?.subIndex ?? -1) >= 0 ? 'Audio & Subtitles (subtitles on)' : 'Audio & Subtitles'}
                onClick={() => openTracks()}
              >
                <Icon name="subtitles" />
                {(sess?.subIndex ?? -1) >= 0 && <span class="sub-dot" />}
              </div>
            )}
            {toneMapped && picture.value?.canEdit && (
              <div class="btn icon focusable" tabIndex={-1} data-fkey="p-picture" title="Picture (HDR brightness)" onClick={openPicture}>
                <Icon name="brightness" />
              </div>
            )}
            {it?.Type === 'Episode' && it.SeriesId && (
              <div class="btn icon focusable" tabIndex={-1} data-fkey="p-episodes" title="Episodes" onClick={() => setShowEps(true)}>
                <Icon name="episodes" />
              </div>
            )}
            {next && (
              <div class="btn focusable" tabIndex={-1} onClick={() => playNext(next)}>
                <Icon name="next" />
                Next Episode
              </div>
            )}
            <div class="spacer" />
            <div class={'btn icon focusable info-btn' + (showInfo ? ' on' : '')} tabIndex={-1} title="Playback info" onClick={() => setShowInfo((v) => !v)}>
              <Icon name="info" />
            </div>
            {!isNative && !isAndroidTV && (document.fullscreenEnabled || (document as any).webkitFullscreenEnabled) && (
              <div class="btn icon focusable fs-btn" tabIndex={-1} title="Fullscreen (F)" onClick={() => toggleFullscreen().then(() => setFsTick((n) => n + 1))}>
                <Icon name={document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'} />
              </div>
            )}
          </div>
          {showInfo && sess && (
            <div class="p-info">
              <InfoRow k="Playback" v={sess.playMethod === 'DirectPlay' ? 'Direct Play' : sess.playMethod === 'DirectStream' ? 'Direct Stream' : 'Transcode'} />
              <InfoRow k="Container" v={sess.playMethod === 'DirectPlay' ? sess.source.Container?.toUpperCase() : 'HLS'} />
              <InfoRow k="Video" v={[vInfo?.Codec?.toUpperCase(), vInfo?.VideoRangeType && vInfo.VideoRangeType !== 'SDR' ? vInfo.VideoRangeType : '', vInfo?.Width ? `${vInfo.Width}×${vInfo.Height}` : ''].filter(Boolean).join(' · ')} />
              {videoSize && <InfoRow k="Output" v={videoSize} />}
              <InfoRow k="Audio" v={aInfo ? audioLabel(aInfo) : ''} />
              <InfoRow k="Decoder" v={decoder} />
              {sess.source.Bitrate ? <InfoRow k="Bitrate" v={`${(sess.source.Bitrate / 1e6).toFixed(1)} Mbps`} /> : null}
              {transcodeReasons && <InfoRow k="Reason" v={transcodeReasons} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div class="p-info-row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function SeekBar({ pct, bpct, dur, chapters, preview, focusable, chapterName, onScrub }: { pct: number; bpct: number; dur: number; chapters: { StartPositionTicks: number }[]; preview: number | null; focusable: boolean; chapterName?: string; onScrub?: (ms: number, done: boolean) => void }) {
  // Mouse: press/drag on the timeline previews, release seeks.
  const at = (e: PointerEvent) => {
    const t = (e.currentTarget as HTMLElement).querySelector('.seek-track')!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - t.left) / t.width)) * dur;
  };
  return (
    <div
      class={'seek' + (focusable ? ' focusable' : '')}
      tabIndex={focusable ? -1 : undefined}
      onPointerDown={(e) => {
        if (!onScrub || !dur || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onScrub(at(e), false);
      }}
      onPointerMove={(e) => {
        if (onScrub && dur && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) onScrub(at(e), false);
      }}
      onPointerUp={(e) => {
        if (!onScrub || !dur || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        onScrub(at(e), true);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="seek-track">
        <div class="seek-buf" style={{ transform: `scaleX(${bpct})` }} />
        <div class="seek-fill" style={{ transform: `scaleX(${pct})` }} />
        {dur > 0 &&
          chapters.length > 1 &&
          chapters.slice(1).map((c, i) => <i key={i} class="seek-tick" style={{ left: `${((c.StartPositionTicks / TICKS_PER_MS) / dur) * 100}%` }} />)}
        <div class="seek-head" style={{ left: `${pct * 100}%` }} />
      </div>
      {preview !== null && (
        <div class="seek-preview" style={{ left: `${pct * 100}%` }}>
          {fmtClock(preview)}
          {chapterName && !/^chapter \d+$/i.test(chapterName) && <span class="seek-chapter">{chapterName}</span>}
        </div>
      )}
    </div>
  );
}
