import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Backdrop } from './components/Backdrop';
import { Dialog, Toast, dialog, showToast } from './components/Dialog';
import { SubtitleFinderHost } from './components/SubtitleFinder';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Search } from './pages/Search';
import { Settings } from './pages/Settings';
import { Requests } from './pages/Requests';
import { Downloads } from './pages/Downloads';
import { Detail } from './pages/Detail';
import { Person } from './pages/Person';
import { TmdbPage } from './pages/Tmdb';
import { Player } from './pages/Player';
import { Login } from './pages/Login';
import { MobileChrome } from './components/MobileChrome';
import { Icon, IconName } from './components/icons';
import { auth, logout, setAuth, DEFAULT_SERVER } from './lib/jellyfin';
import { tab, stack, switchTab, tabStep, pop, push, takeRestore, visitedTabs, top, visibleTabs, playback, playbackActive, closePlayback } from './lib/router';
import './lib/pip'; // picture-in-picture: global Menu = full screen
import './lib/caps'; // per-user capabilities (hides Downloads etc.)
import './lib/remote'; // phone remote host (resumes polling when a phone is paired)
import { dashAvailable, switchSide, viewCameFromTextInput } from './lib/sides';
import { needsServerSetup, ServerSetup } from './components/ServerSetup';
import './styles/sides.css';
import { pushHandler, startRemote } from './lib/input';
import { current, focusEl, move, page, restoreIn, focusFirst } from './lib/focus';
import { itemFromEl, contextMenu, playItem, isPlayTile } from './lib/actions';
import { log } from './lib/log';
import { send } from './lib/bridge';
import { fmtTime, loadServerClock } from './lib/clock';
import { dataRev, invalidate } from './lib/datasync';
import { installLongPress, armLongPress, longPressRepeat } from './lib/longpress';

loadServerClock();
installLongPress();

/** Bumped when playback ends / watched state changes so Home / detail refetch (see lib/datasync.ts). */
export { dataRev };

function TabBar({ hidden }: { hidden: boolean }) {
  return (
    <nav class={'tabbar' + (hidden ? ' away' : '')} data-lastresort data-group="tabbar">
      <div class="tabbar-inner">
        {visibleTabs.value.map((t) => (
          <div
            key={t.id}
            class={'tab focusable' + (t.id === tab.value ? ' selected' : '')}
            tabIndex={-1}
            data-fkey={'tab-' + t.id}
            onFocus={() => tab.value !== t.id && switchTab(t.id)}
            onClick={() => {
              if (tab.value !== t.id) switchTab(t.id);
              requestAnimationFrame(() => restoreIn(document.querySelector(`.page[data-tab="${t.id}"]`)));
            }}
          >
            <Icon name={t.id as IconName} />
            {t.label}
          </div>
        ))}
        {dashAvailable.value && (
          <div class="tab tab-side focusable" tabIndex={-1} data-fkey="tab-side-dash" onClick={() => switchSide('dash')}>
            <Icon name="dash" />
            Dash
          </div>
        )}
      </div>
    </nav>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(t);
  }, []);
  void now;
  return <div class="clock">{fmtTime()}</div>;
}

function TabPage({ id, active }: { id: string; active: boolean }) {
  const rk = dataRev.value;
  switch (id) {
    case 'home':
      return <Home active={active} refreshKey={rk} />;
    case 'movies':
      return <Library type="Movie" title="Movies" active={active} refreshKey={rk} />;
    case 'shows':
      return <Library type="Series" title="Shows" active={active} refreshKey={rk} />;
    case 'search':
      return <Search active={active} />;
    case 'requests':
      return <Requests active={active} />;
    case 'downloads':
      return <Downloads active={active} />;
    case 'settings':
      return <Settings active={active} />;
  }
  return null;
}

function activePageEl() {
  return document.querySelector<HTMLElement>('.page.active');
}

export function App() {
  const a = auth.value;
  const st = stack.value;
  const routeTop = top.value;
  const [scrolled, setScrolled] = useState(false);
  const prevLen = useRef(st.length);

  // Global (lowest-priority) input handler: spatial nav, select, back, tabs, paging, shortcuts.
  useEffect(() => {
    return pushHandler((e) => {
      const a = e.action;
      const cur = current();
      const inTabBar = !!cur?.closest('.tabbar');
      const atTabRoot = stack.value.length === 0;
      switch (a) {
        case 'up':
        case 'left':
        case 'right':
          if (!cur) return focusFirst(activePageEl() ?? document.body), true;
          move(a);
          return true;
        case 'down':
          if (inTabBar) {
            restoreIn(activePageEl()?.querySelector('[data-group]') ?? activePageEl());
            return true;
          }
          if (!cur) return focusFirst(activePageEl() ?? document.body), true;
          move(a);
          return true;
        case 'select':
          if (e.repeat) return longPressRepeat(e), true;
          // A on a card waits for release (or 500 ms) so a long press can open the context menu instead.
          if (cur && itemFromEl(cur) && cur.classList.contains('card')) return armLongPress(cur), true;
          if (cur) cur.click();
          else focusFirst(activePageEl());
          return true;
        case 'back':
          if (e.repeat) return true;
          if (dialog.value) return true;
          if (!atTabRoot) {
            pop();
            return true;
          }
          // Tab root: rows -> tab bar -> Home. B at Home root never exits the app.
          if (!inTabBar && tab.value !== 'home') {
            focusEl(document.querySelector<HTMLElement>(`[data-fkey="tab-${tab.value}"]`));
          } else if (tab.value !== 'home') {
            switchTab('home');
            requestAnimationFrame(() => focusEl(document.querySelector<HTMLElement>('[data-fkey="tab-home"]')));
          } else if (!inTabBar) {
            // Home: jump back to the hero (top) — never exit.
            focusEl(document.querySelector<HTMLElement>('.page.active [data-fkey="hero-play"]'));
          }
          return true;
        case 'lb':
        case 'rb':
          if (e.repeat) return true;
          if (atTabRoot) {
            const keepBar = inTabBar;
            if (tabStep(a === 'rb' ? 1 : -1) && keepBar) requestAnimationFrame(() => focusEl(document.querySelector<HTMLElement>(`[data-fkey="tab-${tab.value}"]`)));
          }
          return true;
        case 'lt':
        case 'rt':
          page(a === 'lt' ? 'up' : 'down');
          return true;
        case 'y':
          if (e.repeat) return true;
          if (stack.value.length) stack.value = [];
          switchTab('search');
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('.page.active input');
            if (input) {
              focusEl(input.closest<HTMLElement>('.focusable'));
              input.focus();
            }
          });
          return true;
        case 'x': {
          if (e.repeat) return true;
          const it = itemFromEl(cur);
          // X = quick play where A opens details; on play tiles (A already plays) X opens the menu, no duplicate action.
          if (it && isPlayTile(it) && cur?.classList.contains('card')) contextMenu(it);
          else if (it) playItem(it);
          return true;
        }
        case 'menu': {
          if (e.repeat) return true;
          const it = itemFromEl(cur);
          if (it) contextMenu(it);
          return true;
        }
        case 'view':
          if (e.repeat) return true;
          // Merged Store app: View = switch to the Dash side (the player and text fields keep View for themselves).
          if (dashAvailable.value && !playbackActive.value && !viewCameFromTextInput()) return switchSide('dash'), true; // also in PiP: a side switch reloads the WebView
          focusEl(document.querySelector<HTMLElement>(`[data-fkey="tab-${tab.value}"]`));
          return true;
      }
      return false;
    });
  }, []);

  // Restore focus to the invoker after popping a route; refresh data after playback.
  useEffect(() => {
    const popped = st.length < prevLen.current;
    prevLen.current = st.length;
    if (!popped) return;
    requestAnimationFrame(() => {
      const r = takeRestore();
      if (r) focusEl(r, { instant: true });
      else restoreIn(activePageEl());
    });
  }, [st.length]);

  // Tab bar always stays visible; once the page scrolls, a soft scrim fades in under it so rows pass behind cleanly.
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const t = activePageEl()?.querySelector<HTMLElement>('.vtrack');
      setScrolled(parseFloat(t?.dataset.ty || '0') > 40);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    document.addEventListener('focusin', kick);
    document.addEventListener('wheel', kick, { passive: true });
    return () => {
      document.removeEventListener('focusin', kick);
      document.removeEventListener('wheel', kick);
    };
  }, []);

  // Remote debug hook (POST /api/cmd on the page server).
  useEffect(() => {
    startRemote((c) => {
      if (c.reload) location.reload();
      if (c.send?.type) send(c.send); // raw bridge passthrough (compat with tools/drive.py)
      if (c.auth?.token && c.auth?.userId) setAuth({ server: c.auth.server ?? DEFAULT_SERVER, token: c.auth.token, userId: c.auth.userId, userName: c.auth.userName ?? 'test', serverName: c.auth.serverName });
      if (c.tab) switchTab(c.tab);
      if (c.open) push({ name: 'item', id: c.open });
      if (c.person) push({ name: 'person', jfId: c.person.jfId, tmdbId: c.person.tmdbId });
      if (c.playId) push({ name: 'player', id: c.playId, startMs: c.startMs });
      if (c.stop) closePlayback('remote stop');
      if (c.back) pop();
      if (c.logout) logout();
      if (c.state) log('STATE', { tab: tab.value, stack: stack.value.map((s) => s.route), focus: current()?.dataset.fkey ?? current()?.textContent?.slice(0, 40), w: innerWidth, h: innerHeight });
    });
  }, []);

  if (!a) {
    return (
      <>
        <Backdrop />
        {needsServerSetup.value ? <ServerSetup /> : <Login />}
      </>
    );
  }

  const onPlayer = routeTop.name === 'player';
  const pb = playback.value;
  return (
    <>
      <Backdrop />
      {!onPlayer && <Clock />}
      <div class={'top-scrim' + (scrolled && st.length === 0 ? ' on' : '')} />
      <TabBar hidden={st.length > 0} />
      <div class="pages">
        {visitedTabs.value.map((id) => (
          <div key={id} class={'page' + (st.length === 0 && tab.value === id ? ' active' : '')} data-tab={id}>
            <TabPage id={id} active={st.length === 0 && tab.value === id} />
          </div>
        ))}
        {st.map((entry, i) =>
          entry.route.name === 'item' ? (
            <div key={entry.key} class={'page push' + (i === st.length - 1 ? ' active' : '')}>
              <Detail id={entry.route.id} seasonId={entry.route.seasonId} active={i === st.length - 1} />
            </div>
          ) : entry.route.name === 'person' ? (
            <div key={entry.key} class={'page push' + (i === st.length - 1 ? ' active' : '')}>
              <Person jfId={entry.route.jfId} tmdbId={entry.route.tmdbId} active={i === st.length - 1} />
            </div>
          ) : entry.route.name === 'tmdb' ? (
            <div key={entry.key} class={'page push' + (i === st.length - 1 ? ' active' : '')}>
              <TmdbPage type={entry.route.type} id={entry.route.id} active={i === st.length - 1} />
            </div>
          ) : null,
        )}
      </div>
      {/* Keyed by the playback session, not the route: it stays mounted in picture-in-picture (lib/pip.ts). */}
      {pb && <PlayerHost key={pb.key} id={pb.id} startMs={pb.startMs} fromStart={pb.fromStart} />}
      <SubtitleFinderHost />
      <MobileChrome />
      <Dialog />
      <Toast />
    </>
  );
}

function PlayerHost(p: { id: string; startMs?: number; fromStart?: boolean }) {
  useEffect(() => () => invalidate('playback stopped', 1500), []);
  return <Player {...p} />;
}

export { showToast };
