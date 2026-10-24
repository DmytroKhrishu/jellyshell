// Audio boost preference (Audio & Subtitles → Audio boost / Night mode), remembered per Jellyfin user in localStorage
// and applied to every playback: sent in the `play` message and live via `setAudioBoost` (docs/bridge.md).
//   Browser: lib/webaudio.ts (Web Audio gain + limiter, compressor for night mode).
//   Xbox: the shell runs the stream through FFmpegInteropX with an FFmpeg audio filter chain.
import { signal } from '@preact/signals';
import { auth } from './jellyfin';
import { isNative, send, onNative } from './bridge';
import { log } from './log';
import { boostSupported } from './webaudio';

export interface BoostPref {
  db: number;
  night: boolean;
}

export const BOOST_STEPS = [0, 3, 6, 10];
const key = () => `jellyshell.audioBoost.${auth.value?.userId ?? 'anon'}`;

function load(): BoostPref {
  try {
    const v = JSON.parse(localStorage.getItem(key()) || '{}');
    return { db: BOOST_STEPS.includes(v.db) ? v.db : 0, night: !!v.night };
  } catch {
    return { db: 0, night: false };
  }
}

export const audioBoost = signal<BoostPref>(load());
// Switching user (logout/login) → that user's preference.
auth.subscribe(() => (audioBoost.value = load()));

/** Last ack from the bridge ({applied, path, reason, filter}). */
export const boostAck = signal<{ applied: boolean; path?: string; reason?: string; filter?: string } | null>(null);

export function setBoost(p: Partial<BoostPref>, live = true) {
  audioBoost.value = { ...audioBoost.value, ...p };
  localStorage.setItem(key(), JSON.stringify(audioBoost.value));
  if (live) send({ type: 'setAudioBoost', db: audioBoost.value.db, night: audioBoost.value.night });
}

/** Can this platform boost at all? Native: yes (FFmpeg filter path). Browser: Web Audio, not on iOS / Safari. */
export const boostAvailable = () => isNative || boostSupported();

export const boostLabel = (db: number) => (db > 0 ? `+${db} dB` : 'Off');

onNative((m: any) => {
  if (m.type !== 'audioBoost') return;
  boostAck.value = { applied: !!m.applied, path: m.path, reason: m.reason, filter: m.filter };
  log('audio boost ack', boostAck.value);
});
