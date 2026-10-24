// Minimal native bridge (JellyShell protocol subset). In a desktop browser everything is a no-op.
type Listener = (m: any) => void;
const listeners = new Set<Listener>();
const wv = (window as any).chrome?.webview as
  | { postMessage(m: unknown): void; addEventListener(t: string, cb: (e: { data: any }) => void): void }
  | undefined;

export const isNative = !!wv;

export function onNative(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function send(msg: { type: string; [k: string]: unknown }) {
  wv?.postMessage(msg);
}

if (wv) {
  wv.addEventListener('message', (e) => {
    let m = e.data;
    if (typeof m === 'string') {
      try {
        m = JSON.parse(m);
      } catch {
        return;
      }
    }
    if (m && typeof m.type === 'string') for (const l of [...listeners]) l(m);
  });
}
