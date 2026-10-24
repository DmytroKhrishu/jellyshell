import { useEffect, useRef } from 'preact/hooks';
import { current, focusFirst, focusEl, restoreIn } from './focus';

/** Once `ready`, if this page is active and nothing inside it has focus, focus its first/autofocus element. */
export function useInitialFocus(ref: { current: HTMLElement | null }, active: boolean, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!active || !ready || !ref.current) return;
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const cur = current();
      if (cur && el.contains(cur)) return;
      // Don't steal focus from the tab bar while the user is browsing tabs.
      if (cur && cur.closest('.tabbar')) return;
      if (!done.current) {
        done.current = true;
        focusFirst(el, { instant: true });
      } else restoreIn(el);
    });
    return () => cancelAnimationFrame(id);
  }, [active, ready]);
}

export { focusEl };
