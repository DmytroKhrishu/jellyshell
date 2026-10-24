import { server, bytes } from '../lib/data';
import { Spark, Ring } from '../components/charts';
import { last, memPct } from './Overview';

export function Server() {
  const s = server.value;
  if (!s) return <div class="page-pad muted">Loading…</div>;
  const h = s.hist;
  const cpu = last(h.cpu) ?? 0;
  const temp = last(h.temp) ?? 0;
  const mem = memPct(s);
  const running = s.containers.filter((c: any) => c.state === 'running').length;
  const down = s.containers.filter((c: any) => c.state !== 'running');
  return (
    <div class="page-pad srv-page">
      <div class="cal-head">
        <h1 class="page-title">{s.host}</h1>
        <div class="muted">
          up {Math.floor(s.uptime / 86400)} d · load {s.load.map((x: number) => x.toFixed(2)).join(' ')} · {s.cores} cores · {running}/{s.containers.length} containers running
        </div>
      </div>

      <div class="grid server" data-group="srv">
        <Gauge title="CPU" pct={cpu} label={`${Math.round(cpu)}%`} series={h.cpu} color="#a78bfa" max={100} autofocus />
        <Gauge title="Memory" pct={mem} label={`${Math.round(mem)}%`} sub={`${bytes(s.mem.total - s.mem.available)} / ${bytes(s.mem.total)}`} series={h.mem} color="#60a5fa" max={100} />
        <Gauge title="CPU temp" pct={(temp / 100) * 100} label={`${Math.round(temp)}°`} series={h.temp} color={temp > 80 ? '#f87171' : '#fb923c'} />
        <button class="tile focusable gauge">
          <div class="tile-h">Network{s.netIf ? ` · ${s.netIf}` : ''}</div>
          <div class="net">
            <div><span class="dim">↓</span> <b>{bytes(last(h.rx) ?? 0)}/s</b></div>
            <div><span class="dim">↑</span> <b>{bytes(last(h.tx) ?? 0)}/s</b></div>
          </div>
          <Spark values={h.rx} color="#34d399" height="2.2rem" />
          <Spark values={h.tx} color="#fbbf24" height="1.4rem" />
        </button>
      </div>

      <h2 class="row-title">Disks</h2>
      <div class="grid disks" data-group="disks">
        {s.disks.map((d: any) =>
          d.missing ? (
            <button class="tile focusable disk bad"><div class="tile-h">{d.label}</div><div>Not mounted · {d.mount}</div></button>
          ) : (
            <button class="tile focusable disk">
              <div class="tile-h">{d.label}</div>
              <div class="disk-v"><b>{bytes(d.free)}</b> <span class="dim">free of {bytes(d.total, 0)}</span></div>
              <div class="dbar big"><i class={d.used / d.total > 0.9 ? 'hot' : ''} style={{ width: `${(100 * d.used) / d.total}%` }} /></div>
              <div class="muted small">{d.mount} · {Math.round((100 * d.used) / d.total)}% used</div>
            </button>
          ),
        )}
      </div>

      <h2 class="row-title">Containers {down.length > 0 && <span class="pill bad">{down.length} not running</span>}</h2>
      <div class="ct-grid" data-group="cts" style={{ gridTemplateColumns: `repeat(${ctCols(s.containers.length)}, 1fr)` }}>
        {[...down, ...s.containers.filter((c: any) => c.state === 'running')].map((c: any) => (
          <button class={'ct focusable' + (c.state !== 'running' ? ' bad' : '')}>
            <span class={'dot ' + (c.state === 'running' ? 'ok' : 'bad')} />
            <span class="ct-name">{c.name}</span>
            <span class="ct-cpu dim">{c.cpu == null ? '' : `${c.cpu.toFixed(1)}%`}</span>
            <span class="ct-mem">{c.mem ? bytes(c.mem) : c.status.split(' (')[0].split(' ')[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Enough columns that the container list fits in ~8 rows (the page never scrolls). */
const ctCols = (n: number) => Math.min(4, Math.max(3, Math.ceil(n / 8)));

function Gauge({ title, pct, label, sub, series, color, max, autofocus }: {
  title: string; pct: number; label: string; sub?: string; series: (number | null)[]; color: string; max?: number; autofocus?: boolean;
}) {
  return (
    <button class="tile focusable gauge" data-autofocus={autofocus || undefined}>
      <div class="tile-h">{title}</div>
      <div class="gauge-top">
        <Ring pct={pct} color={color} size="4.2rem"><b>{label}</b></Ring>
        <div class="dim small">{sub ?? 'last hour'}</div>
      </div>
      <Spark values={series} color={color} min={0} max={max} height="2.4rem" />
    </button>
  );
}
