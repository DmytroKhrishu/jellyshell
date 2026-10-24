// Player helpers for intros/recaps (lib/introskip.ts has the rules): auto-skip on entry with a short "Watch intro" undo, and
// the "seen once" bookkeeping for Settings → Skip intros = After first viewing.
//
// One decision per segment per player session (`handled`): seeking back into an intro never re-skips it, and a segment you
// land in mid-way (resume position, explicit seek more than ENTER_MS past its start) is left alone and keeps the Skip button.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Item } from '../lib/jellyfin';
import { Segment } from '../lib/playback';
import { autoSkips, markIntroSeen, segEnd, segKey, segStart } from '../lib/introskip';
import { log } from '../lib/log';
import { Icon } from './icons';
import '../styles/autoskip.css';

const ENTER_MS = 4000; // entered "naturally" = first seen within this of the segment start
const UNDO_MS = Number(new URLSearchParams(location.search).get('undoms')) || 5000; // ?undoms= debug: longer window for screenshots
const OUT_MS = 350;

export interface AutoSkipOpts {
  item: Item | null;
  segments: Segment[];
  pos: number;
  /** Media is actually running (not Opening): a seek sent earlier can get lost. */
  playing: boolean;
  seekTo: (ms: number) => void;
}

export function useAutoSkip(o: AutoSkipOpts) {
  const handled = useRef(new Set<string>());
  const watching = useRef<Segment | null>(null); // an intro being watched (not auto-skipped): seen once it's passed
  const [undo, setUndo] = useState<{ seg: Segment; out: boolean } | null>(null);
  const timers = useRef<number[]>([]);
  const clearTimers = () => (timers.current.forEach((t) => window.clearTimeout(t)), (timers.current = []));
  useEffect(() => clearTimers, []);

  const showUndo = (seg: Segment) => {
    clearTimers();
    setUndo({ seg, out: false });
    timers.current.push(window.setTimeout(() => setUndo((u) => u && { ...u, out: true }), UNDO_MS - OUT_MS));
    timers.current.push(window.setTimeout(() => setUndo(null), UNDO_MS));
  };

  useEffect(() => {
    const { item, segments, pos, playing } = o;
    const w = watching.current;
    if (w) {
      if (pos >= segEnd(w) - 1500) {
        watching.current = null;
        markIntroSeen(item, 'watched');
      } else if (pos < segStart(w) - 1000) watching.current = null; // went back before it: not watched (yet)
    }
    if (!playing || !item) return;
    const seg = segments.find((s) => (s.Type === 'Intro' || s.Type === 'Recap') && pos >= segStart(s) && pos < segEnd(s) - 1500);
    if (!seg || handled.current.has(segKey(seg))) return;
    handled.current.add(segKey(seg));
    const natural = pos - segStart(seg) < ENTER_MS;
    if (natural && autoSkips(item, seg)) {
      log('auto skip', { item: item.Name, type: seg.Type, fromMs: Math.round(pos), toMs: Math.round(segEnd(seg)) });
      o.seekTo(segEnd(seg));
      showUndo(seg);
    } else if (natural && seg.Type === 'Intro') watching.current = seg;
  }, [o.pos, o.segments, o.playing, o.item]);

  /** The Skip button: choosing to skip a show's intro counts as having seen it. */
  const manualSkip = (seg: Segment) => {
    if (seg.Type === 'Intro') markIntroSeen(o.item, 'skipped');
    watching.current = null;
  };

  const undoSkip = () => {
    if (!undo) return;
    clearTimers();
    log('auto skip undone', { item: o.item?.Name, type: undo.seg.Type });
    o.seekTo(segStart(undo.seg));
    setUndo(null);
  };

  const what = undo?.seg.Type === 'Recap' ? 'recap' : 'intro';
  const el = undo ? (
    <div class={'as-undo' + (undo.out ? ' out' : '')}>
      <span class="as-lbl">Skipped {what}</span>
      <div class="btn focusable" tabIndex={-1} data-fkey="as-undo" onClick={undoSkip}>
        <Icon name="undo" /> Watch {what}
      </div>
    </div>
  ) : null;
  return { undo: el, showingUndo: !!undo, manualSkip };
}
