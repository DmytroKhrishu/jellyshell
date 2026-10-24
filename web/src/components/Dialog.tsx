// Global picker dialog + toast. Dialogs trap focus (data-scope) and return focus to the invoker.
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { focusEl, focusFirst } from '../lib/focus';
import { pushHandler } from '../lib/input';
import '../styles/shell-extras.css';
import { Icon, IconName } from './icons';

export interface Opt {
  label: string;
  value: string;
  sub?: string;
  selected?: boolean;
  /** Action row (e.g. "Find subtitles…"): runs onPick without changing the selection. keep = leave the dialog open. */
  action?: boolean;
  keep?: boolean;
  /** Optional leading icon (action rows, context menu). */
  icon?: IconName;
}
export interface Column {
  title: string;
  icon?: IconName;
  /** Optional explanation under the title (e.g. why a sync found nothing). */
  note?: string;
  options: Opt[];
  onPick: (value: string) => void;
}
interface DialogState {
  columns: Column[];
  closeOnPick: boolean;
  invoker: HTMLElement | null;
}

export const dialog = signal<DialogState | null>(null);

export function openPicker(columns: Column[], closeOnPick = true) {
  // Re-opening while open (rebuilding the options) keeps the original invoker for focus return.
  dialog.value = { columns, closeOnPick, invoker: dialog.value?.invoker ?? (document.activeElement as HTMLElement) };
}
export function closeDialog() {
  const d = dialog.value;
  dialog.value = null;
  if (d?.invoker?.isConnected) focusEl(d.invoker);
}

export function Dialog() {
  const d = dialog.value;
  const ref = useRef<HTMLDivElement>(null);
  const open = !!d;
  // Initial focus only when the dialog opens; in-place re-renders keep the focused row.
  useEffect(() => {
    if (!open) return;
    const sel = ref.current?.querySelector<HTMLElement>('.opt.sel');
    if (!sel || !focusEl(sel)) focusFirst(ref.current);
  }, [open]);
  useEffect(() => {
    if (!d) return;
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !ref.current?.contains(cur)) {
      const sel = ref.current?.querySelector<HTMLElement>('.opt.sel');
      if (!sel || !focusEl(sel)) focusFirst(ref.current);
    }
    return pushHandler((e) => {
      if (e.action === 'back' || e.action === 'menu') {
        closeDialog();
        return true;
      }
      return false; // let the global handler do D-pad / A inside the scope
    });
  }, [d]);
  if (!d) return null;
  return (
    <div class="dialog-wrap">
      <div class="dialog" data-scope ref={ref}>
        {d.columns.map((c, ci) => (
          <div class="dialog-col" key={ci} data-group={'dlg' + ci}>
            <h3>
              {c.icon && <Icon name={c.icon} />}
              {c.title}
            </h3>
            {c.note && <p class="dialog-note">{c.note}</p>}
            <div class="dialog-rule" />
            <div class="dialog-list" data-vscroll>
              <div class="vtrack">
                {c.options.map((o, oi) => [
                  o.action && oi > 0 && !c.options[oi - 1].action ? <div key={o.value + '-rule'} class="dialog-rule act-rule" /> : null,
                  <div
                    key={o.value}
                    class={'opt focusable' + (o.selected ? ' sel' : '') + (o.action ? ' act' : '')}
                    tabIndex={-1}
                    data-fkey={'opt-' + o.value}
                    onClick={() => {
                      if (o.action) {
                        if (!o.keep) closeDialog();
                        c.onPick(o.value);
                        if (o.keep && dialog.value === d) {
                          dialog.value = { ...d };
                          requestAnimationFrame(() => focusEl(ref.current?.querySelector<HTMLElement>(`[data-fkey="opt-${CSS.escape(o.value)}"]`)));
                        }
                        return;
                      }
                      c.onPick(o.value);
                      if (d.closeOnPick) closeDialog();
                      else {
                        // re-render selection in place
                        c.options.forEach((x) => (x.selected = x.value === o.value));
                        dialog.value = { ...d };
                      }
                    }}
                  >
                    {o.icon ? <Icon name={o.icon} class="opt-ico" /> : <span class="dot" aria-hidden="true" />}
                    <span class="lbl">{o.label}</span>
                    {o.sub && <span class="sub">{o.sub}</span>}
                  </div>,
                ])}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const toast = signal<string | null>(null);
let toastTimer: number | undefined;
export function showToast(msg: string, ms = 3000) {
  toast.value = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), ms);
}
export function Toast() {
  return toast.value ? <div class="toast">{toast.value}</div> : null;
}
