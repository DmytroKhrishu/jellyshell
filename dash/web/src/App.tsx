import { signal, computed } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { pushHandler, lastInputAt } from './lib/input';
import { current, focusEl, focusFirst, move, page, restoreIn, resetScroll } from './lib/focus';
import { calendar, backdrops, weather, settings, features, now, hm, longDate, until, photoUrl, type Photo, type Feature } from './lib/data';
import { wmo } from './lib/wmo';
import { QR } from './components/charts';
import { Overview } from './pages/Overview';
import { Calendar } from './pages/Calendar';
import { Weather } from './pages/Weather';
import { Home } from './pages/Home';
import { Photos } from './pages/Photos';
import { Server } from './pages/Server';
import { Music } from './pages/Music';
import { Settings } from './pages/Settings';
import { Video, Film } from 'lucide-preact';
import { mediaAvailable, switchSide, setMockNotice, viewCameFromTextInput } from './lib/sides';
import './styles/sides.css';

// `need`: the data source a tab shows. Tabs whose source has no provider (server features) are left out.
const TABS: readonly { id: string; label: string; C: () => any; need?: Feature }[] = [
  { id: 'overview', label: 'Overview', C: Overview },
  { id: 'calendar', label: 'Calendar', C: Calendar, need: 'calendar' },
  { id: 'weather', label: 'Weather', C: Weather, need: 'weather' },
  { id: 'home', label: 'Home', C: Home, need: 'home' },
  { id: 'music', label: 'Music', C: Music, need: 'music' },
  { id: 'photos', label: 'Photos', C: Photos, need: 'photos' },
  { id: 'server', label: 'Server', C: Server, need: 'server' },
  { id: 'settings', label: 'Settings', C: Settings },
];
type TabId = 'overview' | 'calendar' | 'weather' | 'home' | 'music' | 'photos' | 'server' | 'settings';
/** Tabs with a data source (only Overview + Settings until /api/config answers, so nothing flashes in and out). */
const visibleTabs = computed(() => {
  const f = features.value;
  return TABS.filter((t) => !t.need || !!f?.[t.need]);
});

const initial = (location.hash.slice(1) as TabId) || 'overview';
export const tab = signal<TabId>(TABS.some((t) => t.id === initial) ? initial : 'overview');
// A remembered tab whose source went away (or isn't known yet) falls back to Overview once features are known.
features.subscribe((f) => {
  if (f && !visibleTabs.value.some((t) => t.id === tab.value)) {
    const inBar = !!document.activeElement?.closest?.('.tabbar');
    switchTab('overview');
    requestAnimationFrame(() => (inBar ? focusEl(tabEl()) : focusFirst(activePageEl())));
  }
});
const viewer = signal<{ items: Photo[]; i: number } | null>(null);
const ambient = signal(new URLSearchParams(location.search).has('ambient'));
const toastMsg = signal<string | null>(null);
const dismissed = signal<Set<string>>(new Set());
// ?idle=SECONDS overrides the Settings tab (dev); otherwise idleEnabled/idleMinutes from /api/settings.
const IDLE_OVERRIDE = new URLSearchParams(location.search).get('idle');
const idleMs = () => (IDLE_OVERRIDE != null ? Number(IDLE_OVERRIDE) * 1000 : settings.value.idleEnabled ? settings.value.idleMinutes * 60_000 : 0);

const activePageEl = () => document.querySelector<HTMLElement>('.page.active');
const tabEl = () => document.querySelector<HTMLElement>(`[data-fkey="tab-${tab.value}"]`);

export function go(id: TabId) {
  switchTab(id);
  requestAnimationFrame(() => focusFirst(activePageEl()));
}
function switchTab(id: TabId) {
  if (tab.value === id) return;
  tab.value = id;
  history.replaceState(null, '', '#' + id);
  requestAnimationFrame(() => {
    const p = activePageEl();
    if (p) resetScroll(p);
  });
}
function tabStep(d: number) {
  const vt = visibleTabs.value;
  const i = Math.max(0, vt.findIndex((t) => t.id === tab.value));
  switchTab(vt[(i + d + vt.length) % vt.length].id as TabId);
}
export function openPhoto(items: Photo[], i: number) {
  viewer.value = { items, i };
}
setMockNotice((m) => toast(m));
export function toast(m: string) {
  toastMsg.value = m;
  setTimeout(() => toastMsg.value === m && (toastMsg.value = null), 3500);
}

/** The next event with a meeting link starting within 5 minutes (or running < 5 min). */
const meetingAlert = computed(() => {
  const cal = calendar.value;
  const t = now.value.getTime();
  if (!cal) return null;
  return (
    cal.events.find((e) => {
      if (!e.url || e.allDay || dismissed.value.has(e.start + e.title)) return false;
      const st = new Date(e.start).getTime();
      return st - t <= 5 * 60_000 && t - st <= 5 * 60_000;
    }) ?? null
  );
});

/** Landscape backdrops (Wikimedia Commons featured pictures, cached on the server). Shuffled once per load. */
const shuffled = computed(() => [...backdrops.value].sort(() => Math.random() - 0.5));

function Backdrop() {
  const pool = shuffled.value;
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), ambient.value ? 30_000 : 90_000);
    return () => clearInterval(t);
  }, [ambient.value]);
  if (!pool.length) return <div class="backdrop" />;
  const bg = pool[i % pool.length];
  const next = pool[(i + 1) % pool.length];
  return (
    <div class={'backdrop' + (ambient.value ? ' amb' : '')}>
      <div class="bd-layer in" key={bg.file}>
        <img src={`/api/backdrop/${bg.file}`} />
      </div>
      <link rel="prefetch" href={`/api/backdrop/${next.file}`} />
      <div class="bd-dim" />
      <div class="bd-grad" />
      {ambient.value && (
        <div class="amb-place">
          {bg.name}
          <div class="amb-credit">{[bg.artist, bg.license].filter(Boolean).join(' · ')} · Wikimedia Commons</div>
        </div>
      )}
    </div>
  );
}

function TabBar() {
  return (
    <nav class="tabbar" data-lastresort data-group="tabbar">
      <div class="tabbar-inner">
        {visibleTabs.value.map((t) => (
          <div
            key={t.id}
            class={'tab focusable' + (t.id === tab.value ? ' selected' : '')}
            tabIndex={-1}
            data-fkey={'tab-' + t.id}
            onFocus={() => switchTab(t.id as TabId)}
            onClick={() => {
              switchTab(t.id as TabId);
              requestAnimationFrame(() => restoreIn(activePageEl()));
            }}
          >
            {t.label}
          </div>
        ))}
        {mediaAvailable.value && (
          <div class="tab tab-side focusable" tabIndex={-1} data-fkey="tab-side-media" onClick={() => switchSide('media')}>
            <Film size="1.25rem" />
            Media
          </div>
        )}
      </div>
    </nav>
  );
}

function TopClock() {
  const w = weather.value?.current;
  const c = w ? wmo(w.weather_code, !!w.is_day) : null;
  return (
    <div class="clock">
      {c && <span class="clock-wx"><c.Icon size="1.1em" /> {Math.round(w.temperature_2m)}°</span>}
      {hm(now.value)}
    </div>
  );
}

function Ambient() {
  const d = now.value;
  const w = weather.value?.current;
  const c = w ? wmo(w.weather_code, !!w.is_day) : null;
  const next = calendar.value?.events
    .filter((e) => !e.allDay && new Date(e.start) > d && new Date(e.start).toDateString() === d.toDateString())
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))[0];
  return (
    <div class="ambient">
      <div class="amb-time">{hm(d)}</div>
      <div class="amb-date">{longDate(d)}</div>
      <div class="amb-row">
        {c && <span><c.Icon size="1em" /> {Math.round(w.temperature_2m)}° {c.label}</span>}
        {next && <span class="amb-next"><span class="ev-bar" style={{ background: next.color }} />{next.title} · {until(new Date(next.start), d)}</span>}
      </div>
    </div>
  );
}

function MeetingBanner() {
  const e = meetingAlert.value;
  if (!e) return null;
  const st = new Date(e.start);
  return (
    <div class="meeting glass">
      <div class="meeting-txt">
        <div class="meeting-k"><Video size="1em" /> {st > now.value ? `Starts ${until(st, now.value)}` : 'Started ' + hm(st)}</div>
        <div class="meeting-t">{e.title}</div>
        <div class="muted small">Scan to join · Menu ≡ to dismiss</div>
      </div>
      <QR text={e.url!} size="7.5rem" />
    </div>
  );
}

function Viewer() {
  const v = viewer.value;
  if (!v) return null;
  const ph = v.items[v.i];
  return (
    <div class="viewer" data-scope>
      <img key={ph.id} src={photoUrl(ph.id)} />
      <div class="viewer-cap">
        {ph.place && <b>{ph.place}</b>} {ph.taken && <span class="dim">{new Date(ph.taken).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
        <span class="muted"> · {v.i + 1}/{v.items.length}</span>
      </div>
    </div>
  );
}

export function App() {
  const t = tab.value;
  const amb = ambient.value;
  document.documentElement.className = document.documentElement.className.replace(/\b(tab-\S+|amb)\b/g, '').replace(/\s+/g, ' ').trim() + ' tab-' + t + (amb ? ' amb' : '');

  // Global input: spatial nav + tabs + viewer + ambient wake.
  useEffect(() => {
    const off1 = pushHandler((e) => {
      const a = e.action;
      const cur = current();
      const inTabBar = !!cur?.closest('.tabbar');
      switch (a) {
        case 'up':
        case 'left':
        case 'right':
          if (!cur) return focusFirst(activePageEl() ?? document.body), true;
          if (a === 'up' && !inTabBar) {
            // Leaving the page upwards always lands on the CURRENT tab. move() would pick the
            // geometrically nearest tab (last-resort target), whose onFocus switches pages.
            const here = tab.value;
            if (!move(a) || current()?.closest('.tabbar')) {
              switchTab(here);
              focusEl(tabEl());
            }
            return true;
          }
          move(a);
          return true;
        case 'down':
          if (inTabBar) return restoreIn(activePageEl()), true;
          if (!cur) return focusFirst(activePageEl() ?? document.body), true;
          move(a);
          return true;
        case 'select':
          if (!e.repeat) cur ? cur.click() : focusFirst(activePageEl());
          return true;
        case 'back':
          if (e.repeat) return true;
          if (!inTabBar) focusEl(tabEl());
          else if (tab.value !== 'overview') switchTab('overview'), requestAnimationFrame(() => focusEl(tabEl()));
          else ambient.value = true;
          return true;
        case 'lb':
        case 'rb':
          if (!e.repeat) {
            tabStep(a === 'rb' ? 1 : -1);
            requestAnimationFrame(() => (inTabBar ? focusEl(tabEl()) : focusFirst(activePageEl())));
          }
          return true;
        case 'lt':
        case 'rt':
          page(a === 'lt' ? 'up' : 'down');
          return true;
        case 'menu': {
          const m = meetingAlert.value;
          if (m) dismissed.value = new Set([...dismissed.value, m.start + m.title]);
          return true;
        }
        case 'y':
          ambient.value = true;
          return true;
        case 'view':
          // Merged Store app: View = back to the Media side (not from a text field).
          if (!e.repeat && mediaAvailable.value && !viewCameFromTextInput()) switchSide('media');
          return true;
      }
      return false;
    });
    // Higher priority: viewer, then ambient (pushed last = tried first).
    const off2 = pushHandler((e) => {
      const v = viewer.value;
      if (!v || e.action === 'view') return false; // View switches sides even from the photo viewer
      if (e.action === 'back' || e.action === 'select') viewer.value = null;
      else if (e.action === 'left' || e.action === 'right') {
        const n = v.items.length;
        viewer.value = { ...v, i: (v.i + (e.action === 'right' ? 1 : -1) + n) % n };
      }
      return true;
    });
    const off3 = pushHandler((e) => {
      if (!ambient.value) return false;
      ambient.value = false;
      // View must still switch to Media when the idle screen is up (the default idle timeout is minutes, so a
      // View press after a pause would otherwise only wake the dash and look like it did nothing).
      return e.action !== 'view';
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);

  // Idle -> ambient. Also wake on mouse movement in browsers.
  useEffect(() => {
    let lastMouse = performance.now();
    const mm = () => {
      lastMouse = performance.now();
      if (ambient.value) ambient.value = false;
    };
    window.addEventListener('mousemove', mm, { passive: true });
    const iv = setInterval(() => {
      const idle = performance.now() - Math.max(lastInputAt(), lastMouse);
      if (!ambient.value && !viewer.value && idleMs() > 0 && idle > idleMs()) ambient.value = true;
    }, 5000);
    return () => {
      clearInterval(iv);
      window.removeEventListener('mousemove', mm);
    };
  }, []);

  // Pages render after their data arrives: keep one focus alive (never lose it to an empty page).
  useEffect(() => {
    const iv = setInterval(() => {
      if (!ambient.value && !viewer.value && !current()) focusFirst(activePageEl()) || focusEl(tabEl());
    }, 250);
    return () => clearInterval(iv);
  }, []);

  return (
    <>
      <Backdrop />
      <div class={'ui' + (amb ? ' hidden' : '')}>
        <div class="top-scrim on" />
        <TabBar />
        <TopClock />
        <div class="pages">
          {visibleTabs.value.map(({ id, C }) => (
            <div class={'page' + (id === t ? ' active' : '') + (id === 'home' ? '' : ' fit')} data-tab={id} key={id}>
              {/* Only Home is tall enough to scroll; every other page is laid out to fit one 1080p screen. */}
              {id === 'home' ? (
                <div class="vscroll" data-vscroll data-margintop="11rem">
                  <div class="vtrack">{id === t && <C />}</div>
                </div>
              ) : (
                <div class="fitbox">{id === t && <C />}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      {amb && <Ambient />}
      <MeetingBanner />
      <Viewer />
      {toastMsg.value && <div class="toast glass">{toastMsg.value}</div>}
    </>
  );
}
