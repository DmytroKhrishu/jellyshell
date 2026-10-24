// Navigation stack. Tabs are roots; detail pages and the player push on top of the current tab.
import { signal, computed } from '@preact/signals';
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
export const playerActive = computed(() => top.value.name === 'player');

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
  const returnFocus = document.activeElement as HTMLElement | null;
  // A detail page for the same item already on top: replace instead of stacking duplicates.
  stack.value = [...stack.value, { key: seq++, route, returnFocus }];
  log('push', route);
}

export function replaceTop(route: Route) {
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
