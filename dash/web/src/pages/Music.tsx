import { useEffect, useState } from 'preact/hooks';
import { SkipBack, SkipForward, Play, Pause, Minus, Plus, Volume2, Speaker, Shuffle, Repeat, Repeat1, Music as MusicIcon } from 'lucide-preact';
import { nowPlaying, npFast, npActive, npPosition, npCommand, mmss, type NowPlaying } from '../lib/data';
import { toast } from '../App';

/** Re-render every `ms` while mounted (for client-side progress interpolation between polls). */
export function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function Progress({ n, times }: { n: NowPlaying; times?: boolean }) {
  useTick(1000);
  const pos = npPosition(n);
  const total = n.total_time || 0;
  const pct = total ? (100 * pos) / total : 0;
  return (
    <div class="np-prog">
      <div class="np-bar" key={`${n.title}·${n.artist}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {times && total > 0 && (
        <div class="np-times">
          <span>{mmss(pos)}</span>
          <span>−{mmss(total - pos)}</span>
        </div>
      )}
    </div>
  );
}

async function send(a: Parameters<typeof npCommand>[0]) {
  const r = await npCommand(a);
  if (r?.error) toast(`HomePod: ${r.error}`);
}

export function Music() {
  const n = nowPlaying.value;
  useEffect(() => {
    npFast.value = true;
    return () => (npFast.value = false);
  }, []);
  const active = npActive(n);
  const art = active ? n?.artwork_url : null;

  return (
    <div class="page-pad np-page">
      <div class="np-bg">{art && <img key={art} src={art} />}</div>
      {!active || !n ? (
        <div class="np-idle">
          <div class="np-idle-icon"><Speaker size="4.5rem" /></div>
          <div class="np-idle-t">{n?.configured === false ? 'Now playing isn\'t set up' : n && !n.available ? `${n.device ?? 'the HomePod'} isn't reachable` : `Nothing playing on ${n?.device ?? 'the HomePod'}`}</div>
          <div class="muted np-idle-s">
            {n?.configured === false ? 'Set NP_DEVICE_ID and run the now-playing sidecar to show a HomePod or Apple TV here.' : n && !n.available ? 'The HomePod may be asleep or offline. This page updates by itself when it comes back.' : 'Play something on the HomePod from your iPhone and it shows up here.'}
          </div>
        </div>
      ) : (
        <div class="np-main">
          <div class="np-art">
            {art ? <img key={art} src={art} /> : <div class="np-art-ph"><MusicIcon size="8rem" /></div>}
          </div>
          <div class="np-info">
            <div class="np-src">
              <Speaker size="1em" /> {n.device}
              {n.app && <span class="muted">· {n.app}</span>}
              <span class="np-modes">
                {n.shuffle && n.shuffle !== 'off' && <Shuffle size="1em" />}
                {n.repeat === 'track' ? <Repeat1 size="1em" /> : n.repeat && n.repeat !== 'off' ? <Repeat size="1em" /> : null}
              </span>
              {n.device_state === 'paused' && <span class="pill">Paused</span>}
              {n.mock && <span class="pill">sample data</span>}
            </div>
            <div class="np-title">{n.title}</div>
            {n.artist && <div class="np-artist">{n.artist}</div>}
            {n.album && <div class="np-album dim">{n.album}</div>}
            <Progress n={n} times />
            <div class="np-ctrls" data-group="np-ctrl" data-block="left right">
              <button class="np-btn focusable" data-fkey="np-prev" onClick={() => send('previous')}><SkipBack size="2.4rem" fill="currentColor" /></button>
              <button class="np-btn big focusable" data-fkey="np-pp" data-autofocus onClick={() => send('play_pause')}>
                {n.device_state === 'playing' ? <Pause size="3.2rem" fill="currentColor" /> : <Play size="3.2rem" fill="currentColor" />}
              </button>
              <button class="np-btn focusable" data-fkey="np-next" onClick={() => send('next')}><SkipForward size="2.4rem" fill="currentColor" /></button>
            </div>
            <div class="np-vol" data-group="np-vol" data-block="left right">
              <button class="np-btn sm focusable" data-fkey="np-vdn" onClick={() => send('volume_down')}><Minus size="1.8rem" /></button>
              <Volume2 size="1.8rem" class="dim" />
              <div class="np-vbar"><i style={{ width: `${n.volume ?? 0}%` }} /></div>
              <span class="np-vnum">{n.volume == null ? '—' : Math.round(n.volume)}</span>
              <button class="np-btn sm focusable" data-fkey="np-vup" onClick={() => send('volume_up')}><Plus size="1.8rem" /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
