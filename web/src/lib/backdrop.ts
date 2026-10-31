// App-wide: clicking/tapping a modal's dimmed backdrop closes it, through the same path as B / Escape.
// Mark the backdrop element (the full-screen wrap, not the panel) with `data-backdrop`. The modal's own pushHandler
// then decides what 'back' means (close the confirm first, ignore while a download runs, ...), so there is one
// close path per modal and no per-component onClick.
// Only a press that STARTS and ENDS on the backdrop counts: a text drag from inside the panel that lets go over the
// backdrop fires `click` on the wrap too, and must not close the modal.
import { dispatch } from './input';

let downOn: EventTarget | null = null;

const isBackdrop = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && t.hasAttribute('data-backdrop');

document.addEventListener('pointerdown', (e) => (downOn = e.target), true);
document.addEventListener(
  'click',
  (e) => {
    const t = e.target;
    const started = downOn;
    downOn = null;
    if (!isBackdrop(t) || started !== t) return;
    e.stopPropagation(); // page/player click handlers underneath must not also react
    dispatch('back', 'key');
  },
  true,
);
