// Phone remote page (remote.html → served at /remote). One screen, never scrolls: a swipe pad (or D-pad), the Xbox
// buttons, and a keyboard sheet that types into whatever text field the TV has focused. While the TV plays, a Now Playing
// panel (remote/player.tsx) replaces the pad, one tap away in the header. docs/remote.md.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '@fontsource-variable/inter';
import { Icon, IconName } from '../components/icons';
import { hostName, netError, online, pair, phoneName, send, startWatch, token, tv, unpairSelf } from './api';
import { PlayerPanel } from './player';
import './remote.css';

type Mode = 'swipe' | 'dpad';
const MODE_KEY = 'jsr.mode';
const VIEW_KEY = 'jsr.view';

const buzz = (ms = 8) => (navigator as any).vibrate?.(ms);
const tap = (a: string) => (buzz(), send({ a, t: 'tap' }));

// ---------------- pairing ----------------
function PairScreen() {
  const fromHash = (location.hash.match(/\d{6}/) || [''])[0];
  const [code, setCode] = useState(fromHash);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const go = async (c = code) => {
    const digits = c.replace(/\D/g, '');
    if (digits.length !== 6 || busy) return;
    setBusy(true);
    setErr('');
    try {
      await pair(digits);
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e: any) {
      setErr(e?.message || 'Could not pair');
      setCode('');
      input.current?.focus();
    }
    setBusy(false);
  };
  useEffect(() => {
    if (fromHash) void go(fromHash);
  }, []);

  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = (navigator as any).standalone || matchMedia('(display-mode: standalone)').matches;
  return (
    <div class="pair">
      <div class="pair-ico">
        <Icon name="phone" />
      </div>
      <h1>Pair with your TV</h1>
      <p>On the TV open JellyShell → Settings → Phone remote, then enter the code shown there.</p>
      <input
        ref={input}
        class="pair-code"
        inputMode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]*"
        maxLength={7}
        placeholder="000 000"
        value={code}
        disabled={busy}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
          setCode(v);
          if (v.length === 6) void go(v);
        }}
      />
      <button class="pair-go" disabled={busy || code.replace(/\D/g, '').length !== 6} onClick={() => go()}>
        {busy ? 'Pairing…' : 'Pair'}
      </button>
      {err && <div class="pair-err">{err}</div>}
      {ios && !standalone && <p class="pair-tip">Tip: Share → Add to Home Screen gives you a full-screen remote. The pairing carries over.</p>}
    </div>
  );
}

// ---------------- swipe pad ----------------
const STEP = 44; // px of finger travel per D-pad step
const FIRST = 22; // a short flick still counts as one step
const HOLD_MS = 480;

function SwipePad() {
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ dir: string; n: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const el = ref.current!;
    let g: { id: number; ax: number; ay: number; moved: boolean; held: boolean; timer: number } | null = null;
    let n = 0;
    const show = (dir: string) => setFlash({ dir, n: ++n });
    const down = (e: PointerEvent) => {
      if (g) return;
      el.setPointerCapture(e.pointerId);
      setPressed(true);
      const timer = window.setTimeout(() => {
        if (g && !g.moved) {
          g.held = true;
          buzz(20);
          send({ a: 'select', t: 'down' }); // long press = hold A (context menu on cards)
          show('hold');
        }
      }, HOLD_MS);
      g = { id: e.pointerId, ax: e.clientX, ay: e.clientY, moved: false, held: false, timer };
    };
    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id || g.held) return;
      const dx = e.clientX - g.ax;
      const dy = e.clientY - g.ay;
      const need = g.moved ? STEP : FIRST;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < need) return;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      if (!g.moved) window.clearTimeout(g.timer);
      g.moved = true;
      // Anchor moves by whole steps along the dominant axis; the other axis resets (no diagonal drift).
      if (dir === 'left' || dir === 'right') {
        g.ax += Math.sign(dx) * need;
        g.ay = e.clientY;
      } else {
        g.ay += Math.sign(dy) * need;
        g.ax = e.clientX;
      }
      tap(dir);
      show(dir);
    };
    const up = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      window.clearTimeout(g.timer);
      if (g.held) send({ a: 'select', t: 'up' });
      else if (!g.moved && e.type === 'pointerup') {
        tap('select');
        show('select');
      }
      g = null;
      setPressed(false);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, []);
  return (
    <div class={'pad swipe' + (pressed ? ' pressed' : '')} ref={ref}>
      <div class="pad-hint">Swipe to move · tap for OK · hold for menu</div>
      {flash && <div key={flash.n} class={'pad-flash ' + flash.dir} />}
    </div>
  );
}

// ---------------- D-pad ----------------
/** A button that sends press/release, so holding it repeats on the TV like a held controller button. */
function HoldBtn(p: { a: string; class: string; children?: preact.ComponentChildren; label: string }) {
  const [on, setOn] = useState(false);
  const active = useRef(false);
  const start = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    active.current = true;
    setOn(true);
    buzz();
    send({ a: p.a, t: 'down' });
  };
  const end = () => {
    if (!active.current) return;
    active.current = false;
    setOn(false);
    send({ a: p.a, t: 'up' });
  };
  return (
    <button class={p.class + (on ? ' on' : '')} aria-label={p.label} onPointerDown={start as any} onPointerUp={end} onPointerCancel={end} onContextMenu={(e) => e.preventDefault()}>
      {p.children}
    </button>
  );
}

function DPad() {
  return (
    <div class="pad dpad">
      <div class="dpad-ring">
        <HoldBtn a="up" class="dp up" label="Up">
          <Icon name="chevUp" />
        </HoldBtn>
        <HoldBtn a="left" class="dp left" label="Left">
          <Icon name="chevLeft" />
        </HoldBtn>
        <HoldBtn a="select" class="dp ok" label="OK">
          OK
        </HoldBtn>
        <HoldBtn a="right" class="dp right" label="Right">
          <Icon name="chevRight" />
        </HoldBtn>
        <HoldBtn a="down" class="dp down" label="Down">
          <Icon name="chevDown" />
        </HoldBtn>
      </div>
    </div>
  );
}

// ---------------- keyboard sheet ----------------
function KeyboardSheet({ onClose }: { onClose: () => void }) {
  const t = tv.value?.text;
  const [v, setV] = useState(t && !t.secret ? t.value : '');
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef(0);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const push = (val: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => send({ text: val }), 90);
  };
  return (
    <div class="kb">
      <div class="kb-bar">
        <span class="kb-label">
          <Icon name="keyboard" /> {t ? `Typing in ${t.label}` : 'Type on the TV'}
        </span>
        <button class="kb-done" onClick={onClose}>
          Done
        </button>
      </div>
      <form
        class="kb-row"
        onSubmit={(e) => {
          e.preventDefault();
          window.clearTimeout(timer.current);
          send({ text: v });
          send({ key: 'enter' });
          buzz();
          input.current?.blur();
          onClose();
        }}
      >
        <input
          ref={input}
          type={t?.secret ? 'password' : 'search'}
          value={v}
          placeholder={t?.secret ? 'Password' : 'Search or type…'}
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="go"
          onInput={(e) => {
            const val = (e.target as HTMLInputElement).value;
            setV(val);
            push(val);
          }}
          onBlur={() => window.setTimeout(() => document.activeElement !== input.current && onClose(), 150)}
        />
        <button type="submit" class="kb-enter" aria-label="Enter">
          <Icon name="enter" />
        </button>
      </form>
    </div>
  );
}

// ---------------- main ----------------
function Btn(p: { a?: string; onTap?: () => void; class?: string; icon?: IconName; label: string; text?: string }) {
  return (
    <button
      class={'rb ' + (p.class ?? '')}
      aria-label={p.label}
      onPointerDown={(e) => {
        e.preventDefault();
        if (p.a) tap(p.a);
        else {
          buzz();
          p.onTap?.();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {p.icon && <Icon name={p.icon} />}
      {p.text && <span>{p.text}</span>}
    </button>
  );
}

function Remote() {
  const [mode, setMode] = useState<Mode>((localStorage.getItem(MODE_KEY) as Mode) || 'swipe');
  const [kb, setKb] = useState(false);
  const [menu, setMenu] = useState(false);
  const [view, setView] = useState<'pad' | 'player'>(localStorage.getItem(VIEW_KEY) === 'player' ? 'player' : 'pad');
  const state = tv.value;
  const off = online.value === false;
  useEffect(() => {
    startWatch();
  }, []);
  const flip = (m: Mode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    show('pad');
  };
  const show = (v: 'pad' | 'player') => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };
  const np = state?.player;
  const playerView = view === 'player' && !!np && !off;
  return (
    <div class="remote">
      <header class="top">
        <div class="tv">
          <span class={'dot' + (off ? ' off' : online.value ? ' on' : '')} />
          <span class="tv-name">{hostName.value}</span>
          {(off || netError.value) && <span class="tv-off">{netError.value ? 'No connection' : 'Offline'}</span>}
        </div>
        <div class="seg" role="tablist">
          <button class={mode === 'swipe' && !playerView ? 'sel' : ''} onClick={() => flip('swipe')} aria-label="Swipe pad">
            <Icon name="touchpad" />
          </button>
          <button class={mode === 'dpad' && !playerView ? 'sel' : ''} onClick={() => flip('dpad')} aria-label="D-pad">
            <Icon name="gamepad" />
          </button>
          {np && !off && (
            <button class={'seg-np' + (playerView ? ' sel' : '')} onClick={() => show('player')} aria-label="Now playing">
              <Icon name={np.paused ? 'pause' : 'play'} fill />
            </button>
          )}
        </div>
        <button class="more" aria-label="Options" onClick={() => setMenu(!menu)}>
          <Icon name="more" />
        </button>
      </header>
      {menu && (
        <div class="menu" onClick={() => setMenu(false)}>
          <div class="menu-card" onClick={(e) => e.stopPropagation()}>
            <div class="menu-title">Paired with {hostName.value}</div>
            <button
              class="menu-row danger"
              onClick={() => {
                setMenu(false);
                void unpairSelf();
              }}
            >
              <Icon name="close" /> Unpair this {phoneName() === 'Browser' ? 'device' : phoneName()}
            </button>
            <button class="menu-row" onClick={() => setMenu(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {off && !netError.value && (
        <div class="banner">
          <Icon name="offline" /> {hostName.value} isn't listening. Open JellyShell on it.
        </div>
      )}
      {!off && state?.text && !kb && (
        <button class="banner type" onClick={() => setKb(true)}>
          <Icon name="keyboard" /> {state.text.label} is selected. Tap to type
        </button>
      )}
      {playerView && np && <PlayerPanel p={np} />}
      {np && !playerView && (
        <div class="np">
          <div class="np-text" onClick={() => show('player')}>
            <div class="np-title">{np.title}</div>
            {np.sub && <div class="np-sub">{np.sub}</div>}
          </div>
          <button class="np-pp" aria-label={np.paused ? 'Play' : 'Pause'} onPointerDown={(e) => (e.preventDefault(), buzz(), send({ playpause: true }))}>
            <Icon name={np.paused ? 'play' : 'pause'} fill />
          </button>
        </div>
      )}

      {!playerView && (mode === 'swipe' ? <SwipePad /> : <DPad />)}

      <div class={'shoulders' + (playerView ? ' hidden' : '')}>
        <Btn a="lt" label="LT" text="LT" class="sh" />
        <Btn a="lb" label="LB" text="LB" class="sh" />
        <Btn a="rb" label="RB" text="RB" class="sh" />
        <Btn a="rt" label="RT" text="RT" class="sh" />
      </div>

      <div class={'bottom' + (playerView ? ' hidden' : '')}>
        <div class="utils">
          <Btn a="back" label="Back" icon="back" class="u" />
          <Btn label="Keyboard" icon="keyboard" class="u" onTap={() => setKb(true)} />
          <Btn a="view" label="View" icon="viewBtn" class="u" />
          <Btn a="menu" label="Menu" icon="menuBtn" class="u" />
          <Btn label="Play / pause" icon={np?.paused ? 'play' : 'pause'} class="u" onTap={() => send({ playpause: true })} />
        </div>
        <div class="abxy">
          <Btn a="y" label="Y" text="Y" class="face y" />
          <Btn a="x" label="X" text="X" class="face x" />
          <Btn a="back" label="B" text="B" class="face b" />
          <Btn a="select" label="A" text="A" class="face a" />
        </div>
      </div>

      {kb && <KeyboardSheet onClose={() => setKb(false)} />}
    </div>
  );
}

function App() {
  return token.value ? <Remote /> : <PairScreen />;
}

// iOS: no pinch / double-tap zoom, no rubber-band, no long-press callout anywhere on this page.
document.addEventListener('gesturestart', (e) => e.preventDefault());
// Lists inside sheets (.scroll) scroll themselves; the page never does.
document.addEventListener('touchmove', (e) => !(e.target as Element)?.closest?.('input, .scroll') && e.preventDefault(), { passive: false });
render(<App />, document.getElementById('remote')!);
