import { weather, now as nowSig, unconfigured } from '../lib/data';
import { wmo, aqiLabel, uvLabel } from '../lib/wmo';
import { HourlyChart } from '../components/charts';
import { nowHourIdx } from './Overview';
import { Sunrise, Sunset, Droplets, Wind, Thermometer, Umbrella, Leaf, SunMedium } from 'lucide-preact';

export function Weather() {
  const w = weather.value;
  if (!w) return <div class="page-pad muted">{unconfigured.value['/api/weather'] ?? 'Loading…'}</div>;
  const cur = w.current;
  const c = wmo(cur.weather_code, !!cur.is_day);
  const i0 = nowHourIdx(w);
  const temps = w.hourly.temperature_2m.slice(i0, i0 + 25);
  const precip = w.hourly.precipitation_probability.slice(i0, i0 + 25);
  const labels = w.hourly.time.slice(i0, i0 + 25).map((t: string, i: number) => (i === 0 ? 'Now' : t.slice(11, 13)));
  const rainSoon = rainNextHour(w);
  const daylight = dayLen(w.daily.sunrise[0], w.daily.sunset[0]);
  const lo = Math.min(...w.daily.temperature_2m_min);
  const hi = Math.max(...w.daily.temperature_2m_max);

  return (
    <div class="page-pad wx-page">
      <div class="wx-hero">
        <c.Icon size="6.5rem" strokeWidth={1.4} />
        <div>
          <div class="wx-temp">{Math.round(cur.temperature_2m)}°</div>
          <div class="wx-label">{c.label} · {w.place}</div>
          <div class="dim">H {Math.round(w.daily.temperature_2m_max[0])}° L {Math.round(w.daily.temperature_2m_min[0])}°</div>
          <div class={'wx-rain' + (rainSoon ? ' on' : '')}>{rainSoon ?? 'No rain expected in the next hour'}</div>
        </div>
        <div class="wx-now" data-group="wx-now">
          <Stat Icon={Droplets} label="Humidity" v={`${cur.relative_humidity_2m}%`} />
          <Stat Icon={Wind} label="Wind" v={`${Math.round(cur.wind_speed_10m)} km/h`} />
          <Stat Icon={Thermometer} label="Feels like" v={`${Math.round(cur.apparent_temperature)}°`} />
          <Stat Icon={Umbrella} label="Rain today" v={`${w.daily.precipitation_probability_max[0]}%`} />
        </div>
      </div>

      <div class="grid weather" data-group="wx">
        <button class="tile focusable tile-wide tile-hourly" data-autofocus>
          <div class="tile-h">Next 24 hours</div>
          <HourlyChart temps={temps} precip={precip} labels={labels} height="100%" />
        </button>

        <button class="tile focusable">
          <div class="tile-h">7 days</div>
          <div class="days">
            {w.daily.time.map((t: string, i: number) => {
              const x = wmo(w.daily.weather_code[i]);
              const a = w.daily.temperature_2m_min[i];
              const b = w.daily.temperature_2m_max[i];
              return (
                <div class="day">
                  <span class="day-n">{i === 0 ? 'Today' : new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                  <x.Icon size="1.6rem" />
                  <span class="day-p">{w.daily.precipitation_probability_max[i] >= 20 ? `${w.daily.precipitation_probability_max[i]}%` : ''}</span>
                  <span class="dim day-lo">{Math.round(a)}°</span>
                  <span class="range"><i style={{ left: `${((a - lo) / (hi - lo)) * 100}%`, right: `${100 - ((b - lo) / (hi - lo)) * 100}%` }} /></span>
                  <span class="day-hi">{Math.round(b)}°</span>
                </div>
              );
            })}
          </div>
        </button>

        <div class="stat-grid">
          <Stat Icon={Sunrise} label="Sunrise" v={w.daily.sunrise[0].slice(11)} sub={`Daylight ${daylight}`} />
          <Stat Icon={Sunset} label="Sunset" v={w.daily.sunset[0].slice(11)} sub={`Tomorrow ${w.daily.sunset[1]?.slice(11) ?? ''}`} />
          <Stat Icon={SunMedium} label="UV index" v={Math.round(w.daily.uv_index_max[0])} sub={uvLabel(w.daily.uv_index_max[0])} />
          <Stat Icon={Leaf} label="Air quality" v={w.air?.european_aqi ?? '—'} sub={aqiLabel(w.air?.european_aqi)} />
        </div>
      </div>
    </div>
  );
}

function Stat({ Icon, label, v, sub }: { Icon: any; label: string; v: any; sub?: string }) {
  return (
    <button class="tile focusable stat">
      <div class="stat-h dim"><Icon size="1.1em" /> {label}</div>
      <div class="stat-v">{v}</div>
      {sub && <div class="dim small">{sub}</div>}
    </button>
  );
}

function rainNextHour(w: any): string | null {
  const m = w.minutely_15;
  if (!m) return null;
  const now = nowSig.value.getTime();
  for (let i = 0; i < m.time.length; i++) {
    const t = new Date(m.time[i]).getTime();
    if (t < now - 15 * 60_000) continue;
    if (t > now + 60 * 60_000) break;
    if (m.precipitation[i] > 0.05) {
      const mins = Math.max(0, Math.round((t - now) / 60_000));
      return mins <= 5 ? 'Raining now' : `Rain likely in ~${mins} min`;
    }
  }
  return null;
}

function dayLen(a: string, b: string) {
  const m = (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}
