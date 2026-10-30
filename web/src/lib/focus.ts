// Hand-rolled spatial focus manager on real DOM focus.
//  .focusable           -> can receive focus (tabIndex=-1 is set automatically)
//  [data-group]         -> remembers its last focused child; entering it restores that child
//  [data-scope]         -> traps focus (dialogs / player); the newest visible scope wins
//  [data-hscroll]       -> horizontal row: its first child (the track) is translated to keep focus in view
//  [data-vscroll]       -> vertical scroller: first child translated; [data-scrolltop] on a focus target resets to 0
//  [data-fkey]          -> stable key for focus restoration
//  [data-block="up left"] on an element or group -> do not leave in those directions
import { signal } from '@preact/signals';

export type Dir = 'up' | 'down' | 'left' | 'right';

const memory = new WeakMap<Element, HTMLElement>();
export const focusedKey = signal<string | null>(null);

function visible(el: HTMLElement) {
  if (!el.isConnected) return false;
  if ((el as any).checkVisibility) return (el as any).checkVisibility({ visibilityProperty: true });
  return el.offsetParent !== null;
}

export function scopeRoot(): HTMLElement {
  const scopes = Array.from(document.querySelectorAll<HTMLElement>('[data-scope]')).filter(visible);
  return scopes[scopes.length - 1] ?? document.body;
}

export function focusables(root: Element = scopeRoot()): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.focusable')).filter((e) => {
    if ((e as any).disabled) return false;
    // ignore focusables that belong to a nested (inner) scope of root
    const s = e.parentElement?.closest('[data-scope]');
    if (s && s !== root && root.contains(s)) return false;
    return visible(e);
  });
}

export function current(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a.classList?.contains('focusable') && scopeRoot().contains(a) && visible(a) ? a : null;
}

export function focusEl(el: HTMLElement | null | undefined, opts: { instant?: boolean; noReveal?: boolean } = {}) {
  if (!el) return false;
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
  el.focus({ preventScroll: true });
  for (let g = el.parentElement?.closest<HTMLElement>('[data-group]'); g; g = g.parentElement?.closest<HTMLElement>('[data-group]')) {
    memory.set(g, el);
  }
  focusedKey.value = el.dataset.fkey ?? null;
  if (!opts.noReveal) reveal(el, opts.instant);
  return true;
}

/** Remember `el` as the restore target of its groups without focusing it. */
export function remember(el: HTMLElement | null) {
  if (!el) return;
  for (let g = el.parentElement?.closest<HTMLElement>('[data-group]'); g; g = g.parentElement?.closest<HTMLElement>('[data-group]')) memory.set(g, el);
}

export function focusFirst(root: Element | null | undefined, opts: { instant?: boolean } = {}) {
  if (!root) return false;
  const pref = root.querySelector<HTMLElement>('[data-autofocus].focusable');
  if (pref && visible(pref)) return focusEl(pref, opts);
  const list = focusables(root as HTMLElement);
  return focusEl(list[0], opts);
}

export function focusKey(key: string, root: Element = document.body, opts: { instant?: boolean } = {}) {
  const el = root.querySelector<HTMLElement>(`[data-fkey="${CSS.escape(key)}"]`);
  return el && visible(el) ? focusEl(el, opts) : false;
}

/** Restore the remembered child of a group if it still exists. */
export function restoreIn(group: Element | null | undefined) {
  if (!group) return false;
  const m = memory.get(group);
  if (m && m.isConnected && visible(m)) return focusEl(m);
  return focusFirst(group);
}

function rectOf(el: HTMLElement) {
  return el.getBoundingClientRect();
}

function blocked(el: HTMLElement, dir: Dir) {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const b = n.dataset?.block;
    if (b && b.split(/\s+/).includes(dir)) return n;
    if (n.hasAttribute?.('data-scope')) break;
  }
  return null;
}

/** `quiet`: no edge bump when nothing is there (the caller does something else instead). */
export function move(dir: Dir, quiet = false): boolean {
  const root = scopeRoot();
  const cur = current();
  if (!cur) return focusFirst(root);
  const all = focusables(root).filter((e) => e !== cur);
  const c = rectOf(cur);
  const ccx = c.left + c.width / 2;
  const ccy = c.top + c.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  const blk = blocked(cur, dir);
  const inLastResort = !!cur.closest('[data-lastresort]');
  let fallback: HTMLElement | null = null;
  let fallbackScore = Infinity;
  for (const el of all) {
    if (blk && !blk.contains(el)) continue;
    const lastResort = !inLastResort && !!el.closest('[data-lastresort]');
    const r = rectOf(el);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let primary: number, secondary: number;
    switch (dir) {
      case 'right':
        if (cx <= ccx + 1 || r.left < c.left + c.width * 0.5) continue;
        primary = Math.max(0, r.left - c.right);
        secondary = overlapGap(c.top, c.bottom, r.top, r.bottom);
        break;
      case 'left':
        if (cx >= ccx - 1 || r.right > c.right - c.width * 0.5) continue;
        primary = Math.max(0, c.left - r.right);
        secondary = overlapGap(c.top, c.bottom, r.top, r.bottom);
        break;
      case 'down':
        if (cy <= ccy + 1 || r.top < c.top + c.height * 0.5) continue;
        primary = Math.max(0, r.top - c.bottom);
        secondary = Math.abs(cx - ccx);
        break;
      default:
        if (cy >= ccy - 1 || r.bottom > c.bottom - c.height * 0.5) continue;
        primary = Math.max(0, c.top - r.bottom);
        secondary = Math.abs(cx - ccx);
    }
    const horiz = dir === 'left' || dir === 'right';
    const score = horiz ? primary + secondary * 6 : primary * 2 + secondary;
    if (lastResort) {
      if (score < fallbackScore) {
        fallbackScore = score;
        fallback = el;
      }
      continue;
    }
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) best = fallback;
  if (!best) {
    if (!quiet) bump(cur, dir);
    return false;
  }
  // Entering another group: prefer its remembered child (rows keep their position).
  const curGroup = cur.closest('[data-group]');
  const g = best.closest<HTMLElement>('[data-group]');
  if (g && g !== curGroup && !g.contains(cur) && !(g.dataset.group === 'spatial')) {
    const m = memory.get(g);
    if (m && m.isConnected && visible(m) && m !== cur) best = m;
    else best = rowEntry(best, cur, dir) ?? best;
  }
  return focusEl(best);
}

/** Up/Down from outside any row (search field, buttons, season pills) into a row never visited: start at the row's
 *  marked card (the series page's up-next episode), else its first card, not whichever card sits under the source. */
function rowEntry(best: HTMLElement, cur: HTMLElement, dir: Dir): HTMLElement | null {
  if (dir !== 'up' && dir !== 'down') return null;
  const row = best.closest<HTMLElement>('[data-hscroll]');
  if (!row || cur.closest('[data-hscroll]')) return null;
  const pref = row.querySelector<HTMLElement>('[data-autofocus].focusable');
  if (pref && visible(pref)) return pref;
  return focusables(row)[0] ?? null;
}

function overlapGap(a1: number, a2: number, b1: number, b2: number) {
  if (b2 < a1) return a1 - b2;
  if (b1 > a2) return b1 - a2;
  return 0;
}

function bump(el: HTMLElement, dir: Dir) {
  el.classList.remove('bump-left', 'bump-right', 'bump-up', 'bump-down');
  void el.offsetWidth;
  el.classList.add('bump-' + dir);
  setTimeout(() => el.classList.remove('bump-' + dir), 260);
}

// ---------------- scrolling (transform-based, compositor only) ----------------
function setTx(track: HTMLElement, x: number, instant?: boolean) {
  if (instant) track.style.transition = 'none';
  track.style.transform = `translate3d(${-x}px,0,0)`;
  track.dataset.tx = String(x);
  if (instant) {
    void track.offsetWidth;
    track.style.transition = '';
  }
}
function setTy(track: HTMLElement, y: number, instant?: boolean) {
  if (instant) track.style.transition = 'none';
  track.style.transform = `translate3d(0,${-y}px,0)`;
  track.dataset.ty = String(y);
  if (instant) {
    void track.offsetWidth;
    track.style.transition = '';
  }
}

function offsetWithin(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0,
    y = 0;
  for (let n: HTMLElement | null = el; n && n !== ancestor; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
    if (!n.offsetParent) break;
  }
  return { x, y };
}

/** Mobile layout: rows/pages are native scrollers (CSS), so the transform tracks stay put. */
const nativeScroll = () => document.documentElement.classList.contains('mode-mobile');

/**
 * Max horizontal shift of a row track: the LAST card's right edge + the track's right padding (TV-safe area) + room for
 * the focus scale must fit inside the viewport. track.scrollWidth drops the flex container's end padding, which left
 * the last card cut by the screen edge.
 */
function hMax(h: HTMLElement, track: HTMLElement) {
  const last = track.lastElementChild as HTMLElement | null;
  if (!last) return 0;
  // Rect centre is unaffected by the card's own focus scale and both rects share the track's translate.
  const lr = last.getBoundingClientRect();
  const right = lr.left + lr.width / 2 - track.getBoundingClientRect().left + last.offsetWidth / 2;
  const padR = parseFloat(getComputedStyle(track).paddingRight) || 0;
  const grow = last.offsetWidth * 0.05; // focused card scales up ~1.08 around its centre
  return Math.max(0, Math.ceil(right + padR + grow - h.clientWidth));
}

export function reveal(el: HTMLElement, instant?: boolean) {
  if (nativeScroll()) {
    // Keyboard / D-pad on a tablet: bring the focused element into view natively. Touch never focuses.
    if (!document.documentElement.classList.contains('touch')) el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: instant ? 'auto' : 'smooth' });
    return;
  }
  const h = el.closest<HTMLElement>('[data-hscroll]');
  if (h) {
    const track = h.firstElementChild as HTMLElement;
    const { x } = offsetWithin(el, track);
    const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    setTx(track, Math.min(hMax(h, track), Math.max(0, x - pad)), instant);
  }
  const v = el.closest<HTMLElement>('[data-vscroll]');
  if (v) {
    const track = v.firstElementChild as HTMLElement;
    if (el.closest('[data-scrolltop]')) {
      setTy(track, 0, instant);
      return;
    }
    const target = (el.closest<HTMLElement>('[data-scrollunit]') ?? el) as HTMLElement;
    const { y } = offsetWithin(target, track);
    const cur = parseFloat(track.dataset.ty || '0');
    const H = v.clientHeight;
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const len = (s: string | undefined) => (s ? (s.endsWith('rem') ? parseFloat(s) * remPx : parseFloat(s)) : NaN);
    const top = len(v.dataset.margintop) || H * 0.14;
    const bottom = len(v.dataset.marginbottom) || H * 0.1;
    const max = Math.max(0, track.scrollHeight - H);
    let ny = cur;
    if (v.dataset.vscroll === 'anchor') ny = y - top;
    else if (y - cur < top) ny = y - top;
    else if (y + target.offsetHeight - cur > H - bottom) ny = y + target.offsetHeight - (H - bottom);
    setTy(track, Math.min(max, Math.max(0, ny)), instant);
  }
}

/** Mouse wheel / trackpad: scroll the row or page under the pointer (same transform tracks as reveal()). */
export function wheelScroll(target: Element, dx: number, dy: number, shift: boolean): boolean {
  if (nativeScroll()) return false; // let the browser scroll natively
  const horiz = shift || Math.abs(dx) > Math.abs(dy);
  const d = horiz ? (Math.abs(dx) > Math.abs(dy) ? dx : dy) : dy;
  if (!d) return false;
  if (horiz) {
    const h = target.closest<HTMLElement>('[data-hscroll]');
    if (h) {
      const t = h.firstElementChild as HTMLElement;
      const max = hMax(h, t);
      setTx(t, Math.min(max, Math.max(0, parseFloat(t.dataset.tx || '0') + d)), true);
      return true;
    }
  }
  const scope = scopeRoot();
  let v = target.closest<HTMLElement>('[data-vscroll]');
  if (!v || !scope.contains(v)) v = scope.querySelector<HTMLElement>('.page.active [data-vscroll], [data-vscroll]');
  if (!v) return false;
  const t = v.firstElementChild as HTMLElement;
  const max = Math.max(0, t.scrollHeight - v.clientHeight);
  setTy(t, Math.min(max, Math.max(0, parseFloat(t.dataset.ty || '0') + d)), true);
  return true;
}

export function resetScroll(root: HTMLElement) {
  if (nativeScroll()) root.querySelectorAll<HTMLElement>('[data-vscroll]').forEach((v) => (v.scrollTop = 0));
  root.querySelectorAll<HTMLElement>('[data-vscroll] > *:first-child').forEach((t) => setTy(t, 0, true));
}

/** Move focus by roughly one viewport (LT/RT): repeat the move until we travelled `fraction` of the screen. */
export function page(dir: 'up' | 'down', fraction = 0.8) {
  const start = current();
  if (!start) return false;
  const y0 = start.getBoundingClientRect().top;
  const target = window.innerHeight * fraction;
  let moved = false;
  for (let i = 0; i < 40; i++) {
    const before = current();
    // measure using layout offsets so transforms mid-animation don't confuse us
    if (!move(dir)) break;
    moved = true;
    const now = current();
    if (!now || now === before) break;
    const dy = Math.abs(layoutTop(now) - layoutTop(start)) || Math.abs(now.getBoundingClientRect().top - y0);
    if (dy >= target) break;
  }
  return moved;
}

function layoutTop(el: HTMLElement) {
  let y = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}
