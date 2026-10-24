import { Speaker, Music as MusicIcon } from 'lucide-preact';
import { nowPlaying, npActive } from '../lib/data';
import { Progress } from './Music';
import { go } from '../App';

/** Overview "Now Playing" tile: live HomePod state only (no controls); A opens the Music tab. */
export function NowPlayingTile() {
  const n = nowPlaying.value;
  const dev = n?.device ?? 'the HomePod';
  const active = npActive(n) && !!n;
  return (
    <button class={'tile focusable tile-np' + (active ? '' : ' idle')} data-fkey="ov-np" onClick={() => go('music')}>
      {active ? (
        <>
          <div class="tnp-art">{n.artwork_url ? <img key={n.artwork_url} src={n.artwork_url} /> : <MusicIcon size="2.4rem" />}</div>
          <div class="tnp-main">
            <div class="tile-h"><Speaker size="1em" /> {n.device_state === 'paused' ? 'Paused' : 'Now playing'} · {n.device}</div>
            <div class="tnp-title">{n.title}</div>
            <div class="tnp-artist dim">{n.artist}</div>
            <Progress n={n} />
          </div>
        </>
      ) : (
        <div class="tnp-idle muted"><Speaker size="1.2em" /> {n?.configured === false ? 'Now playing isn\'t set up' : `Nothing playing on ${dev}`}</div>
      )}
    </button>
  );
}
