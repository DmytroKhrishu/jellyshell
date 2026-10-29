// Navigation stack. Tabs are roots; detail pages and the player push on top of the current tab.
import { signal, computed, effect } from '@preact/signals';
import { log } from './log';

export interface TabDef {
  id: string;
  label: string;
  /** Phones: lives under the bottom bar's "More" tab instead of its own slot. */
  more?: boolean;
}
// Data-driven so future tabs (Requests via Seerr/Sonarr/Radarr) are one entry + one page component.
export const TABS: TabDef[] = [
  { id: 'home', label: 'Home' },
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'Shows' },
  { id: 'search', label: 'Search' },
  { id: 'requests', label: 'Requests', more: true },
  { id: 'downloads', label: 'Downloads', more: true },
  { id: 'settings', label: 'Settings', more: true },
];

export type Route =
  | { name: 'tab'; tab: string }
  | { name: 'item'; id: string; seasonId?: string }
  | { name: 'player'; id: string; startMs?: number; fromStart?: boolean }
  | { name: 'person'; jfId?: string; tmdbId?: number }
  | { name: 'tmdb'; type: 'movie' | 'tv'; id: number };

export interface Entry {
  key: number;
  route: Route;
  returnFocus?: HTMLElement | null; // element to focus when this entry is popped back to
}

let seq = 1;
/** Tabs this user can't use (e.g. Downloads for non-admins; set by lib/caps.ts from the server's capabilities). */
export const hiddenTabs = signal<string[]>([]);
export const visibleTabs = computed<TabDef[]>(() => TABS.filter((t) => !hiddenTabs.value.includes(t.id)));
export const tab = signal<string>('home');
export const stack = signal<Entry[]>([]); // routes above the tab root
export const top = computed<Route>(() => stack.value[stack.value.length - 1]?.route ?? { name: 'tab', tab: tab.value });
export const visitedTabs = signal<string[]>(['home']);
/** The FULL-SCREEN player is on top (clock hidden, View/typing stay with the player). False in picture-in-picture. */
export const playerActive = computed(() => top.value.name === 'player');

// ---------- playback session (lib/pip.ts, docs in components/PipWindow.tsx) ----------
// The mounted Player is keyed by the playback SESSION, not by its stack entry, so it survives leaving the player route
// while it plays in picture-in-picture. Full screen = a `player` route on the stack; PiP = `pip` true and no player route.
// Pushing a player route: same item as the PiP session (and not "from start") = back to full screen, same session;
// anything else = a new session (the old Player unmounts: stop + reportStopped with its position).
export interface PlaySession {
  key: number;
  id: string;
  startMs?: number;
  fromStart?: boolean;
}
type PlayerRoute = Extract<Route, { name: 'player' }>;
export const playback = signal<PlaySession | null>(null);
export const pip = signal(false);
/** Something is playing, full screen or in PiP (reload deferral: lib/wake.ts, lib/renderprobe.ts; View -> Dash). */
export const playbackActive = computed(() => !!playback.value);

function sessionFor(r: PlayerRoute) {
  const cur = playback.peek();
  if (pip.peek() && cur && cur.id === r.id && !r.fromStart && r.startMs === undefined) {
    log('pip: full screen (same item)', r.id);
  } else playback.value = { key: seq++, id: r.id, startMs: r.startMs, fromStart: r.fromStart };
  pip.value = false;
}

/** Player-internal switches (next episode, episode picker, shelf pick): stay in PiP when in PiP, else replace the route. */
export function replacePlayer(r: PlayerRoute) {
  if (pip.peek()) playback.value = { key: seq++, id: r.id, startMs: r.startMs, fromStart: r.fromStart };
  else replaceTop(r);
}

/** Leave the player whatever its state (B, PiP close, end of a movie, errors in PiP). */
export function closePlayback(why: string) {
  if (!playback.peek()) return;
  log('player close', why, { pip: pip.peek() });
  if (pip.peek()) {
    pip.value = false;
    playback.value = null;
  } else if (top.peek().name === 'player') pop();
  else playback.value = null;
}

/** Full screen -> PiP: drop the player route (the app returns to where it was, focus restored); the session lives on. */
export function enterPip() {
  if (!playback.peek() || top.peek().name !== 'player') return;
  pip.value = true;
  pop();
}

// Outside PiP the session follows the top route, as before PiP existed: a player route on top = its session (a fresh one
// if none matches, e.g. B back onto an older player entry), anything else on top = no session (the Player unmounts: stop).
effect(() => {
  const t = top.value;
  if (pip.peek()) return;
  const cur = playback.peek();
  if (t.name === 'player') {
    if (!cur || cur.id !== t.id) playback.value = { key: seq++, id: t.id, startMs: t.startMs, fromStart: t.fromStart };
  } else if (cur) playback.value = null;
});

export function switchTab(id: string) {
  if (!visibleTabs.value.some((t) => t.id === id)) return;
  if (stack.value.length) stack.value = [];
  if (!visitedTabs.value.includes(id)) visitedTabs.value = [...visitedTabs.value, id];
  tab.value = id;
  log('tab', id);
}

export function tabStep(d: 1 | -1) {
  const tabs = visibleTabs.value;
  const i = tabs.findIndex((t) => t.id === tab.value);
  const n = Math.min(tabs.length - 1, Math.max(0, i + d));
  if (n !== i) switchTab(tabs[n].id);
  return n !== i;
}

export function push(route: Route) {
  if (route.name === 'player' && top.peek().name === 'player') return replaceTop(route); // never two players stacked
  if (route.name === 'player') sessionFor(route);
  const returnFocus = document.activeElement as HTMLElement | null;
  // A detail page for the same item already on top: replace instead of stacking duplicates.
  stack.value = [...stack.value, { key: seq++, route, returnFocus }];
  log('push', route);
}

export function replaceTop(route: Route) {
  if (route.name === 'player') sessionFor(route);
  const s = stack.value.slice();
  const last = s.pop();
  stack.value = [...s, { key: seq++, route, returnFocus: last?.returnFocus }];
}

/** Pop the top entry; returns the element that should receive focus (if still mounted). */
export function pop(): boolean {
  const s = stack.value;
  if (!s.length) return false;
  const last = s[s.length - 1];
  stack.value = s.slice(0, -1);
  pendingRestore = last.returnFocus ?? null;
  log('pop', last.route);
  return true;
}

let pendingRestore: HTMLElement | null = null;
export function takeRestore() {
  const r = pendingRestore;
  pendingRestore = null;
  return r && r.isConnected ? r : null;
}
