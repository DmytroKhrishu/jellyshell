// Media ⇄ Dash side switching (docs/store-release.md "One app, two sides").
// The shell adds `side`, `startSide`, `sides {media, dash}` and `uiSource` to its capabilities reply to `hello`.
// An old shell sends none of this, and the desktop browser has no shell: the Dash pill / View switch / "Open on"
// row then stay hidden. `?sides=1` fakes a merged shell in the desktop mock (switches only log + toast).
import { signal, computed } from '@preact/signals';
import { isNative, onNative, send } from './bridge';
import { showToast } from '../components/Dialog';
import { markBundled } from './uisource';
import { log } from './log';

export type Side = 'media' | 'dash';

interface SideInfo {
  side: Side;
  startSide: Side;
  dash: boolean;
  uiSource: string;
}

const MOCK_PARAM = isNative ? null : new URLSearchParams(location.search).get('sides');
/** `?sides=1` = merged shell with a reachable dash; `?sides=unavail` = the switch answers sideUnavailable. */
const MOCK = MOCK_PARAM === '1' || MOCK_PARAM === 'unavail';
const MOCK_START_KEY = 'jellyshell.mockStartSide';

/** null = the shell didn't report sides (old shell / plain browser): side features stay hidden. */
export const sideInfo = signal<SideInfo | null>(
  MOCK ? { side: 'media', startSide: (localStorage.getItem(MOCK_START_KEY) as Side) || 'media', dash: true, uiSource: 'lan' } : null,
);
/** Show the Dash pill and let View switch: only when the shell says the dash side is reachable. */
export const dashAvailable = computed(() => sideInfo.value?.dash === true);

onNative((m: any) => {
  if (m.type === 'capabilities') {
    if (m.uiSource === 'bundled') markBundled();
    if (m.sides && typeof m.sides === 'object') {
      sideInfo.value = {
        side: m.side === 'dash' ? 'dash' : 'media',
        startSide: m.startSide === 'dash' ? 'dash' : 'media',
        dash: m.sides.dash === true,
        uiSource: String(m.uiSource ?? ''),
      };
    }
  } else if (m.type === 'sideUnavailable') sideUnavailable(m.side);
});

function sideUnavailable(side: string) {
  if (sideInfo.value && side === 'dash') sideInfo.value = { ...sideInfo.value, dash: false };
  log('sideUnavailable', side);
  showToast('Dash needs your home server', 4000);
}

export function switchSide(side: Side) {
  log('switchSide', side);
  if (MOCK) {
    if (MOCK_PARAM === 'unavail') return sideUnavailable(side);
    showToast(`Desktop mock: the shell would open ${side === 'dash' ? 'Dash' : 'Media'} now`);
    return;
  }
  send({ type: 'switchSide', side });
}

export function setStartSide(side: Side) {
  const cur = sideInfo.value;
  if (cur) sideInfo.value = { ...cur, startSide: side };
  if (MOCK) localStorage.setItem(MOCK_START_KEY, side);
  else send({ type: 'setStartSide', side });
}

// View pressed while a text field had focus: input.ts moves focus to the field's wrapper before the action is
// dispatched, so remember it here (window capture runs before input.ts's document capture listener).
let viewFromInputAt = -1;
window.addEventListener(
  'keydown',
  (e) => {
    const a = document.activeElement;
    if (e.keyCode === 208 && a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) viewFromInputAt = performance.now();
  },
  true,
);
export const viewCameFromTextInput = () => performance.now() - viewFromInputAt < 300;
