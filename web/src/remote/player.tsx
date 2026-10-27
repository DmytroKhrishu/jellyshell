// Phone remote: Now Playing panel (docs/remote.md "Now playing"). Everything the TV player's bottom bar does, as relay
// `{player:{op,...}}` commands that the TV runs through the player's own handlers (components/RemotePlayer.ts).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PlayerOp, PlayerState } from '../lib/remote';
import { Icon, IconName } from '../components/icons';
import { send, tvAt } from './api';
import { lockNote, lockOn, lockSupported, startLock, stopLock } from './lockscreen';
import './player.css';

const cmd = (o: PlayerOp) => ((navigator as any).vibrate?.(8), send({ player: o }));

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const boostText = (db: number) => (db > 0 ? `+${db} dB` : 'Off');

/** Position now, interpolated from the last TV report (the TV posts on changes plus every ~5 s). */
function usePos(p: PlayerState) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (p.paused || p.buffering) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [p.paused, p.buffering]);
  return Math.min(p.dur || Infinity, p.pos + (p.paused || p.buffering ? 0 : performance.now() - tvAt.value));
}

function Seek({ p, pos }: { p: PlayerState; pos: number }) {
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * p.dur;
  };
  const shown = drag ?? pos;
  const pct = p.dur > 0 ? Math.min(1, shown / p.dur) * 100 : 0;
  return (
    <div class="np-seek">
      <div
        class={'np-track' + (drag !== null ? ' drag' : '')}
        ref={ref}
        onPointerDown={(e) => {
          if (!p.dur) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag(at(e));
        }}
        onPointerMove={(e) => (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId) && setDrag(at(e))}
        onPointerUp={(e) => {
          if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
          cmd({ op: 'seek', ms: Math.round(at(e)) });
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <div class="np-rail">
          <div class="np-fill" style={{ width: pct + '%' }} />
        </div>
        <div class="np-head" style={{ left: pct + '%' }} />
      </div>
      <div class="np-times">
        <span class={drag !== null ? 'hot' : ''}>{clock(shown)}</span>
        <span>−{clock(Math.max(0, p.dur - shown))}</span>
      </div>
    </div>
  );
}

function Tile(p: { icon: IconName; label: string; value: string; on?: boolean; dim?: boolean; onTap: () => void }) {
  return (
    <button class={'np-tile' + (p.on ? ' on' : '') + (p.dim ? ' dim' : '')} onClick={p.onTap}>
      <Icon name={p.icon} />
      <span class="np-tile-text">
        <span class="np-tile-label">{p.label}</span>
        <span class="np-tile-value">{p.value}</span>
      </span>
    </button>
  );
}

type Sheet = 'audio' | 'subs' | 'eps' | 'pic' | null;

function SheetView({ which, p, onClose }: { which: Exclude<Sheet, null>; p: PlayerState; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'center' });
  }, []);
  const row = (key: string | number, label: string, sel: boolean, onTap: () => void, note?: string, extra?: string) => (
    <button key={key} class={'np-row' + (sel ? ' sel' : '') + (extra ? ' ' + extra : '')} onClick={onTap}>
      <span class="np-row-text">
        {label}
        {note && <small>{note}</small>}
      </span>
      {sel && <Icon name="check" />}
    </button>
  );
  let title = '';
  let body: preact.ComponentChildren = null;
  if (which === 'audio') {
    title = 'Audio';
    body = p.audio.map((a) => row(a.i, a.label, a.i === p.a, () => cmd({ op: 'audio', i: a.i })));
  } else if (which === 'subs') {
    title = 'Subtitles';
    body = [
      row('off', 'Off', p.s < 0, () => cmd({ op: 'sub', i: -1 })),
      ...p.subs.map((x) => row(x.i, x.label, x.i === p.s, () => cmd({ op: 'sub', i: x.i }), x.note)),
    ];
  } else if (which === 'eps') {
    title = 'Episodes';
    body = (p.eps ?? []).map((e) => row(e.id, `${e.label} · ${e.name}`, !!e.now, () => (e.now ? undefined : (cmd({ op: 'ep', id: e.id }), onClose())), e.played ? 'Watched' : undefined));
  } else if (which === 'pic' && p.pic) {
    title = 'Picture (HDR brightness)';
    const pic = p.pic;
    body = [
      <div key="bh" class="np-sub-head">Brightness</div>,
      ...pic.bs.map(([v, l]) => row('b' + v, l, Math.abs(v - pic.b) < 0.01, () => cmd({ op: 'pic', b: v }))),
      <div key="ch" class="np-sub-head">Contrast</div>,
      ...pic.cs.map(([v, l]) => row('c' + v, l, Math.abs(v - pic.c) < 0.001, () => cmd({ op: 'pic', c: v }))),
      <div key="n" class="np-note">Changing it restarts the stream on the TV for a moment.</div>,
    ];
  }
  return (
    <div class="menu" onClick={onClose}>
      <div class="menu-card np-sheet" onClick={(e) => e.stopPropagation()}>
        <div class="np-sheet-bar">
          <span class="menu-title">{title}</span>
          <button class="kb-done" onClick={onClose}>
            Done
          </button>
        </div>
        <div class="np-list scroll" ref={list}>
          {body}
        </div>
        {which === 'subs' && p.subOff !== null && (
          <div class="np-offset">
            <span>Timing {p.subOff === 0 ? '0.0 s' : (p.subOff > 0 ? '+' : '−') + (Math.abs(p.subOff) / 1000).toFixed(1) + ' s'}</span>
            <button aria-label="Show earlier" onClick={() => cmd({ op: 'subOff', d: -500 })}>
              <Icon name="minus" />
            </button>
            <button aria-label="Show later" onClick={() => cmd({ op: 'subOff', d: 500 })}>
              <Icon name="plus" />
            </button>
            <button aria-label="Reset timing" onClick={() => cmd({ op: 'subOff', d: 0 })}>
              <Icon name="undo" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PlayerPanel({ p }: { p: PlayerState }) {
  const pos = usePos(p);
  const [sheet, setSheet] = useState<Sheet>(null);
  const audioCur = p.audio.find((a) => a.i === p.a)?.label ?? '—';
  const subCur = p.s < 0 ? 'Off' : p.subs.find((x) => x.i === p.s)?.label ?? 'On';
  const step = Math.round(p.skipMs / 1000);
  const steps = p.boost.steps.length ? p.boost.steps : [0];
  return (
    <div class="np-panel">
      <div class="np-head-text">
        <div class="np-big">{p.title}</div>
        {p.sub && <div class="np-sub">{p.sub}</div>}
      </div>
      <Seek p={p} pos={pos} />
      <div class="np-transport">
        <button class="np-t" aria-label={`Back ${step} seconds`} onClick={() => cmd({ op: 'skip', ms: -p.skipMs })}>
          <Icon name="skipBack" />
          <small>{step}</small>
        </button>
        <button class="np-t main" aria-label={p.paused ? 'Play' : 'Pause'} onClick={() => cmd({ op: 'pp' })}>
          {p.buffering ? <Icon name="busy" class="spin" /> : <Icon name={p.paused ? 'play' : 'pause'} fill />}
        </button>
        <button class="np-t" aria-label={`Forward ${step} seconds`} onClick={() => cmd({ op: 'skip', ms: p.skipMs })}>
          <Icon name="skipFwd" />
          <small>{step}</small>
        </button>
      </div>
      <div class="np-actions">
        {p.seg && (
          <button class="np-pill" onClick={() => cmd({ op: 'skipSeg' })}>
            Skip {p.seg} <Icon name="chevRight" />
          </button>
        )}
        {p.next && (
          <button class="np-pill" onClick={() => cmd({ op: 'next' })}>
            <Icon name="next" /> <span class="np-pill-text">Next: {p.next.label}</span>
          </button>
        )}
      </div>
      <div class="np-tiles">
        <Tile icon="audio" label="Audio" value={audioCur} dim={p.audio.length < 2} onTap={() => setSheet('audio')} />
        <Tile icon="subtitles" label="Subtitles" value={subCur} on={p.s >= 0} onTap={() => setSheet('subs')} />
        <Tile
          icon="boost"
          label="Audio boost"
          value={p.boost.ok ? boostText(p.boost.db) + (p.boost.note ? ' · ' + p.boost.note : '') : 'Not on this TV'}
          on={p.boost.ok && p.boost.db > 0}
          dim={!p.boost.ok}
          onTap={() => p.boost.ok && cmd({ op: 'boost', db: steps[(steps.indexOf(p.boost.db) + 1) % steps.length] })}
        />
        {p.boost.ok && <Tile icon="night" label="Night mode" value={p.boost.night ? 'On' : 'Off'} on={p.boost.night} onTap={() => cmd({ op: 'night', on: !p.boost.night })} />}
        {p.pic && <Tile icon="brightness" label="Picture" value={p.pic.bs.find((b) => Math.abs(b[0] - p.pic!.b) < 0.01)?.[1] ?? 'Custom'} onTap={() => setSheet('pic')} />}
        {p.eps && p.eps.length > 1 && <Tile icon="episodes" label="Episodes" value={`${p.eps.length} in this season`} onTap={() => setSheet('eps')} />}
      </div>
      {lockSupported && (
        <button class={'np-lock' + (lockOn.value ? ' on' : '')} aria-pressed={lockOn.value} onClick={() => (lockOn.value ? stopLock() : void startLock())}>
          <Icon name="lock" />
          <span class="np-lock-text">
            <b>Lock screen controls</b>
            <small>{lockNote.value || (lockOn.value ? 'On: silent audio is playing on this phone' : 'Pause from the lock screen. Plays silent audio here, so your music stops')}</small>
          </span>
          <span class="np-switch" />
        </button>
      )}
      {sheet && <SheetView which={sheet} p={p} onClose={() => setSheet(null)} />}
    </div>
  );
}
