import { calendar, weather, home, server, photos, now, hm, longDate, until, upcoming, relDay, ago, photoUrl, bytes } from '../lib/data';
import { wmo } from '../lib/wmo';
import { Spark } from '../components/charts';
import { go, openPhoto } from '../App';
import { NowPlayingTile } from './NowPlayingTile';
import { Video, MapPin, Sunrise, Sunset, Lightbulb, Thermometer, Droplets, DoorOpen, DoorClosed } from 'lucide-preact';

export function Overview() {
  const d = now.value;
  const w = weather.value;
  const cal = calendar.value;
  const next = cal ? upcoming(cal.events, d).slice(0, 6) : [];
  const h = home.value;
  const s = server.value;
  const mem = photos.value?.memories?.[0];
  const cur = w?.current;
  const c = cur ? wmo(cur.weather_code, !!cur.is_day) : null;

  return (
    <div class="page-pad">
      <div class="hero-row">
      <section class="hero">
        <div class="hero-time">{hm(d)}</div>
        <div class="hero-date">{longDate(d)}</div>
        {cur && c && (
          <div class="hero-weather">
            <c.Icon size="1em" /> <b>{Math.round(cur.temperature_2m)}°</b> <span class="dim">{c.label} · {w.place}</span>
          </div>
        )}
      </section>
      <NowPlayingTile />
      </div>

      <div class="grid overview" data-group="ov">
        <button class="tile focusable tile-cal" data-fkey="ov-cal" data-autofocus onClick={() => go('calendar')}>
          <div class="tile-h">Up next {cal?.mock && <span class="pill">sample data</span>}</div>
          {next.length === 0 && <div class="muted big-empty">Nothing else today</div>}
          {next.map((e, i) => {
            const st = new Date(e.start);
            return (
              <div class={'ev' + (i === 0 ? ' first' : '')}>
                <span class="ev-bar" style={{ background: e.color }} />
                <div class="ev-main">
                  <div class="ev-title">{e.title}</div>
                  <div class="ev-sub dim">
                    {relDay(st, d) === 'Today' ? hm(st) : `${relDay(st, d)} ${hm(st)}`}
                    {e.url && <Video size="0.9em" />}
                    {e.location && <><MapPin size="0.9em" />{e.location}</>}
                  </div>
                </div>
                {i === 0 && <div class="ev-when">{until(st, d)}</div>}
              </div>
            );
          })}
        </button>

        <button class="tile focusable tile-weather" data-fkey="ov-weather" onClick={() => go('weather')}>
          <div class="tile-h">Weather</div>
          {w && (
            <>
              <div class="wx-row">
                {w.hourly.time.slice(nowHourIdx(w), nowHourIdx(w) + 6).map((t: string, i: number) => {
                  const j = nowHourIdx(w) + i;
                  const x = wmo(w.hourly.weather_code[j], !!w.hourly.is_day[j]);
                  return (
                    <div class="wx-h">
                      <div class="dim">{i === 0 ? 'Now' : t.slice(11, 16)}</div>
                      <x.Icon size="1.8rem" />
                      <div>{Math.round(i === 0 ? w.current.temperature_2m : w.hourly.temperature_2m[j])}°</div>
                    </div>
                  );
                })}
              </div>
              <div class="wx-sun dim">
                <Sunrise size="1.1em" /> {w.daily.sunrise[0].slice(11)} <Sunset size="1.1em" /> {w.daily.sunset[0].slice(11)}
                <span class="sep">·</span> H {Math.round(w.daily.temperature_2m_max[0])}° L {Math.round(w.daily.temperature_2m_min[0])}°
              </div>
            </>
          )}
        </button>

        <button class="tile focusable tile-home" data-fkey="ov-home" onClick={() => go('home')}>
          <div class="tile-h">Home {h?.mock && <span class="pill">sample data</span>}{h && !h.mock && <span class="hs-upd">{ago(h.updatedAt)}</span>}</div>
          {h && <HomeLive h={h} />}
        </button>

        <button class="tile focusable tile-server" data-fkey="ov-server" onClick={() => go('server')}>
          <div class="tile-h">Server · {s?.host}</div>
          {s && (
            <div class="srv-mini">
              <Mini label="CPU" v={last(s.hist.cpu)} unit="%" series={s.hist.cpu} color="#a78bfa" />
              <Mini label="RAM" v={memPct(s)} unit="%" series={s.hist.mem} color="#60a5fa" />
              <Mini label="Temp" v={last(s.hist.temp)} unit="°" series={s.hist.temp} color="#f87171" />
              <div class="srv-disks">
                {s.disks.filter((x: any) => !x.missing).map((x: any) => (
                  <div class="dbar-row"><span>{x.label.split(' ·')[0]}</span><div class="dbar"><i style={{ width: `${(100 * x.used) / x.total}%` }} /></div><span class="dim">{bytes(x.free, 0)} free</span></div>
                ))}
              </div>
            </div>
          )}
        </button>

        {mem && (
          <button class="tile focusable tile-photo" data-fkey="ov-photo" onClick={() => openPhoto(mem.assets, 0)}>
            <img src={photoUrl(mem.assets[0].id)} loading="lazy" />
            <div class="photo-cap"><div class="tile-h">On this day</div><div>{mem.title}</div></div>
          </button>
        )}
      </div>
    </div>
  );
}

function Mini({ label, v, unit, series, color }: { label: string; v: number | null; unit: string; series: (number | null)[]; color: string }) {
  return (
    <div class="mini">
      <div class="mini-h"><span class="dim">{label}</span><b>{v == null ? '—' : Math.round(v)}{unit}</b></div>
      <Spark values={series.slice(-120)} color={color} height="2.6rem" />
    </div>
  );
}

export const last = (a: (number | null)[]) => (a.length ? a[a.length - 1] : null);
export const memPct = (s: any) => 100 * (1 - s.mem.available / s.mem.total);
export function nowHourIdx(w: any) {
  const key = w.current.time.slice(0, 13);
  const i = w.hourly.time.findIndex((t: string) => t.slice(0, 13) === key);
  return Math.max(0, i);
}
const flat = (h: any) => h.rooms.flatMap((r: any) => r.accessories.map((a: any) => ({ ...a, room: r.name })));
const isPower = (a: any) => a.type === 'light' || a.type === 'outlet' || a.type === 'switch';

/** "KAJPLATS GU10 WS 575lm 1/2/3" -> one "3× KAJPLATS GU10 WS 575lm" entry. */
function onNames(accs: any[]) {
  const n = new Map<string, number>();
  for (const a of accs) {
    const base = a.name.replace(/\s+\d+$/, '');
    n.set(base, (n.get(base) ?? 0) + 1);
  }
  return [...n].map(([k, c]) => (c > 1 ? `${c}× ${k}` : k));
}

/** Overview Home tile: what's on (per room), climate sensors, door contacts. Read-only; A opens the Home tab. */
function HomeLive({ h }: { h: any }) {
  const all = flat(h);
  const power = all.filter(isPower);
  const on = power.filter((a: any) => a.on);
  const temps = all.filter((a: any) => a.type === 'sensor' && a.unit === '°C');
  const hums = all.filter((a: any) => a.type === 'sensor' && a.unit === '%');
  const doors = all.filter((a: any) => a.kind === 'contact');
  const rooms = h.rooms
    .map((r: any) => ({ name: r.name, on: r.accessories.filter((a: any) => isPower(a) && a.on) }))
    .filter((r: any) => r.on.length);
  const shown = rooms.slice(0, 4);
  const avg = (xs: any[]) => (xs.length ? xs.reduce((s, a) => s + Number(a.value), 0) / xs.length : null);
  const t = avg(temps);
  const hu = avg(hums);
  return (
    <div class="hs">
      <div class="hs-top">
        <span class={'hs-big' + (on.length ? ' lit' : '')}>
          <Lightbulb size="1em" /> <b>{on.length}</b>
          <span class="dim">/{power.length} on</span>
        </span>
        {t != null && <span class="hs-stat"><Thermometer size="1em" /><b>{t.toFixed(1)}°</b></span>}
        {hu != null && <span class="hs-stat"><Droplets size="1em" /><b>{Math.round(hu)}%</b></span>}
        {doors.map((d: any) => {
          const open = d.value === 'Open';
          const I = open ? DoorOpen : DoorClosed;
          return (
            <span class={'hs-stat' + (open ? ' warn' : '')} title={d.name}>
              <I size="1em" />{open ? 'Open' : 'Closed'}
            </span>
          );
        })}
      </div>
      {rooms.length === 0 ? (
        <div class="muted hs-none">Everything is off</div>
      ) : (
        <div class="hs-rooms">
          {shown.map((r: any) => (
            <div class="hs-room">
              <span class="hs-rn">{r.name}</span>
              <span class="hs-on">{onNames(r.on).join(', ')}</span>
            </div>
          ))}
          {rooms.length > shown.length && <div class="muted hs-more">+{rooms.length - shown.length} more rooms</div>}
        </div>
      )}
    </div>
  );
}
