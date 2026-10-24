import { home, homeCommand, ago } from '../lib/data';
import { Lightbulb, LightbulbOff, Power, Thermometer, Droplets, Sparkles, DoorOpen, DoorClosed } from 'lucide-preact';
import { toast } from '../App';

export function Home() {
  const h = home.value;
  if (!h) return <div class="page-pad muted">Loading…</div>;
  const act = async (cmd: Record<string, unknown>, label: string) => {
    // optimistic toggle; the Mac re-pushes real state within a few seconds
    if (cmd.op === 'set') {
      home.value = { ...h, rooms: h.rooms.map((r: any) => ({ ...r, accessories: r.accessories.map((a: any) => (a.id === cmd.id ? { ...a, on: cmd.value } : a)) })) };
    }
    await homeCommand(cmd);
    toast(h.mock ? `${label} — sample data, nothing sent` : label);
  };
  return (
    <div class="page-pad">
      <div class="cal-head">
        <h1 class="page-title">{h.home}</h1>
        <div class="muted">{h.mock ? 'Sample data — HomeClaw on the Mac is not connected yet' : `Synced from Mac · ${ago(h.updatedAt)}`}</div>
      </div>
      <h2 class="row-title">Scenes</h2>
      <div class="chips-row" data-group="scenes">
        {h.scenes.map((s: any, i: number) => (
          <button class="scene focusable" data-autofocus={i === 0 || undefined} onClick={() => act({ op: 'trigger', scene: s.id ?? s.name }, s.name)}>
            <Sparkles size="1.2em" /> {s.name}
          </button>
        ))}
      </div>
      <div class="rooms">
      {h.rooms.map((r: any) => (
        <section class="room" data-scrollunit>
          <h2 class="row-title">{r.name}</h2>
          <div class="acc-grid" data-group={'room-' + r.name}>
            {r.accessories.map((a: any) => (
              <button
                class={'acc focusable' + (a.on ? ' on' : '') + (a.type === 'sensor' ? ' sensor' : '')}
                onClick={() => a.type !== 'sensor' && act({ op: 'set', id: a.id, characteristic: 'power', value: !a.on }, `${a.name} ${a.on ? 'off' : 'on'}`)}
              >
                <AccIcon a={a} />
                <div class="acc-name">{a.name}</div>
                <div class="acc-state">{state(a)}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}

function AccIcon({ a }: { a: any }) {
  if (a.type === 'light' || /light|lamp/i.test(a.name)) return a.on ? <Lightbulb size="2rem" /> : <LightbulbOff size="2rem" />;
  if (a.kind === 'contact') return a.value === 'Open' ? <DoorOpen size="2rem" /> : <DoorClosed size="2rem" />;
  if (a.type === 'sensor') return a.unit === '%' ? <Droplets size="2rem" /> : <Thermometer size="2rem" />;
  return <Power size="2rem" />;
}

function state(a: any) {
  if (a.reachable === false) return 'No response';
  if (a.type === 'sensor') return `${a.value}${a.unit ?? ''}`;
  if (a.type === 'light' || /light|lamp/i.test(a.name)) return a.on ? (a.brightness ? `${a.brightness}%` : 'On') : 'Off';
  return a.on ? 'On' : 'Off';
}
