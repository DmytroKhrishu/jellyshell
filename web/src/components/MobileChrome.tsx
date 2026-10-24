// Mobile chrome (html.mode-mobile only): iOS-style bottom tab bar + "More" sheet, a floating Back button on pushed
// pages, browser/Android back gesture -> app back, swipe on the Home hero, tap outside a sheet = close.
// Everything here is additive: TV and desktop never render it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { TABS, tab, stack, switchTab, top, pop, visibleTabs } from '../lib/router';
import { uiMode } from '../lib/mode';
import { dispatch, pushHandler } from '../lib/input';
import { restoreIn } from '../lib/focus';
import { dialog } from './Dialog';
import '../styles/responsive.css';
import { Icon, I, IconName } from './icons';

function TabIcon({ id }: { id: string }) {
  return <Icon name={(id in I ? id : 'more') as IconName} />;
}

/** Tabs flagged `more` in router.TABS live behind the "More" tab on phones; the bar shows the rest + More. */
const barTabs = () => visibleTabs.value.filter((t) => !t.more);
const moreTabs = () => visibleTabs.value.filter((t) => t.more);

function go(id: string) {
  const sameRoot = tab.value === id && stack.value.length === 0;
  switchTab(id);
  // Tapping the active tab again scrolls its page back to the top (iOS convention).
  requestAnimationFrame(() => {
    const pg = document.querySelector<HTMLElement>(`.page[data-tab="${id}"] .vscroll`);
    if (sameRoot && pg) pg.scrollTo({ top: 0, behavior: 'smooth' });
    else if (!document.documentElement.classList.contains('touch')) restoreIn(document.querySelector(`.page[data-tab="${id}"]`));
  });
}

export function MobileChrome() {
  const mobile = uiMode.value === 'mobile';
  const [more, setMore] = useState(false);
  const routeTop = top.value;
  const depth = stack.value.length;
  useHistorySync(mobile);
  useHeroSwipe(mobile);
  useSheetDismiss(mobile);
  useScrollVar(mobile);
  useEffect(() => setMore(false), [tab.value, depth]);
  // Back (Android back gesture / system Back in the APK, Escape) closes the More sheet before anything else.
  useEffect(() => {
    if (!more) return;
    return pushHandler((e) => {
      if (e.action !== 'back') return false;
      if (!e.repeat) setMore(false);
      return true;
    });
  }, [more]);
  if (!mobile) return null;
  const onPlayer = routeTop.name === 'player';
  const cur = tab.value;
  const inMore = moreTabs().some((t) => t.id === cur);
  return (
    <>
      {depth > 0 && !onPlayer && (
        <button class="m-back" aria-label="Back" onClick={() => dispatch('back', 'key')}>
          <Icon name="chevLeft" stroke={2.4} />
        </button>
      )}
      {!onPlayer && (
        <nav class="m-tabbar" aria-label="Sections">
          {barTabs().map((t) => (
            <button key={t.id} class={'m-tab' + (t.id === cur && !more ? ' on' : '')} onClick={() => go(t.id)} aria-current={t.id === cur ? 'page' : undefined}>
              <TabIcon id={t.id} />
              <span>{t.label}</span>
            </button>
          ))}
          {moreTabs().length > 0 && (
            <button class={'m-tab' + (inMore || more ? ' on' : '')} onClick={() => setMore((v) => !v)} aria-expanded={more}>
              <TabIcon id="more" />
              <span>{inMore && !more ? TABS.find((t) => t.id === cur)?.label : 'More'}</span>
            </button>
          )}
        </nav>
      )}
      {more && (
        <div class="m-sheet-wrap" onClick={(e) => e.target === e.currentTarget && setMore(false)}>
          <div class="m-sheet" role="menu">
            <div class="m-grabber" />
            {moreTabs().map((t) => (
              <button key={t.id} class={'m-sheet-row' + (t.id === cur ? ' on' : '')} role="menuitem" onClick={() => (setMore(false), go(t.id))}>
                <TabIcon id={t.id} />
                <span>{t.label}</span>
                <i class="m-chev"><Icon name="chevRight" /></i>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Mirror the in-app stack into browser history so the Android back button / iOS edge swipe goes back one screen. */
function useHistorySync(on: boolean) {
  const depth = useRef(0);
  const ignore = useRef(0);
  const len = stack.value.length;
  useEffect(() => {
    if (!on) return;
    const onPop = () => {
      if (ignore.current > 0) {
        ignore.current--;
        return;
      }
      depth.current = Math.max(0, depth.current - 1);
      if (dialog.value || document.querySelector('.epp-wrap, .sf-wrap, .rq-sheet-wrap:not(.hidden), .m-sheet-wrap')) {
        dispatch('back', 'key'); // close the sheet, stay on the page
        history.pushState({ js: depth.current + 1 }, '');
        depth.current++;
        return;
      }
      if (stack.value.length > 0) {
        if (top.value.name === 'player') dispatch('back', 'key');
        else pop();
      }
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [on]);
  useEffect(() => {
    if (!on) return;
    if (len > depth.current) {
      while (depth.current < len) history.pushState({ js: ++depth.current }, '');
    } else if (len < depth.current) {
      const n = depth.current - len;
      depth.current = len;
      ignore.current++;
      history.go(-n);
    }
  }, [on, len]);
}

/** Horizontal swipe on the Home hero = previous / next slide (drives the hero's own ‹ › buttons). */
function useHeroSwipe(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let s: { x: number; y: number; t: number; hero: HTMLElement } | null = null;
    const down = (e: TouchEvent) => {
      const hero = (e.target as Element)?.closest?.<HTMLElement>('.page.active .hero');
      s = hero && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), hero } : null;
    };
    const up = (e: TouchEvent) => {
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      const hero = s.hero;
      s = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      const btn = hero.querySelector<HTMLElement>(dx < 0 ? '[data-fkey="hero-next"]' : '[data-fkey="hero-prev"]');
      btn?.click();
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [on]);
}

/** Bottom sheets: tapping the dimmed area above a sheet closes it (same path as B / Escape). */
function useSheetDismiss(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t?.classList?.contains('dialog-wrap') || t?.classList?.contains('rq-sheet-wrap')) {
        e.stopPropagation();
        dispatch('back', 'key');
      }
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, [on]);
}

/** --scroll-y on <html> = scroll offset of the active page: fades the header backdrop as the page scrolls. */
function useScrollVar(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    let raf = 0;
    const set = () => {
      raf = 0;
      const v = document.querySelector<HTMLElement>('.page.active .vscroll');
      root.style.setProperty('--scroll-y', String(v?.scrollTop ?? 0));
    };
    const kick = () => void (raf ||= requestAnimationFrame(set));
    document.addEventListener('scroll', kick, { capture: true, passive: true });
    const unsub = [tab.subscribe(kick), stack.subscribe(kick)];
    return () => {
      document.removeEventListener('scroll', kick, true);
      unsub.forEach((u) => u());
      root.style.removeProperty('--scroll-y');
    };
  }, [on]);
}
