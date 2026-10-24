// Shared "library data changed" signal. Anything that changes watched state, progress or favorites calls
// invalidate(); pages that show that data (Home rows, Library grids, Detail) refetch in the background and keep
// showing the old data meanwhile (useAsync keeps `data` while reloading), so there is no skeleton flash.
import { signal } from '@preact/signals';
import { log } from './log';

export const dataRev = signal(0);

let timer: number | undefined;
/** Bump dataRev. `delayMs` lets the server settle first (e.g. after playback stop is reported). Coalesces bursts. */
export function invalidate(reason: string, delayMs = 0) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    dataRev.value = dataRev.value + 1;
    log('data invalidated', reason, dataRev.value);
  }, delayMs);
}
