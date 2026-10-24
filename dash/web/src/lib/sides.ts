// Media ⇄ Dash side switching (JellyShell docs/store-release.md "One app, two sides").
// The merged shell answers `hello` with capabilities that include `side`, `startSide`, `sides {media, dash}`, `uiSource`.
// An old shell (the standalone Xbox Dash build) and desktop browsers send none of this, so the Media pill / View
// switch stay hidden. `?sides=1` fakes a merged shell in a desktop browser (switches only toast).
import { signal, computed } from '@preact/signals';
import { isNative, onNative, send } from './bridge';

export type Side = 'media' | 'dash';

const MOCK = !isNative && new URLSearchParams(location.search).get('sides') === '1';

/** null until the shell reports sides. */
export const sides = signal<{ media: boolean; dash: boolean } | null>(MOCK ? { media: true, dash: true } : null);
export const mediaAvailable = computed(() => sides.value?.media === true);

onNative((m) => {
  if (m?.type === 'capabilities' && m.sides && typeof m.sides === 'object') {
    sides.value = { media: m.sides.media === true, dash: m.sides.dash === true };
  }
});
if (isNative) send({ type: 'hello' });

let onMock: ((m: string) => void) | null = null;
export const setMockNotice = (fn: (m: string) => void) => (onMock = fn);

export function switchSide(side: Side) {
  if (MOCK) return onMock?.(`Desktop mock: the shell would open ${side === 'media' ? 'Media' : 'Dash'} now`);
  send({ type: 'switchSide', side });
}

// View pressed inside a text field must not switch. input.ts moves focus to the field's wrapper before it dispatches,
// so remember it here (window capture runs before input.ts's document capture listener).
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
