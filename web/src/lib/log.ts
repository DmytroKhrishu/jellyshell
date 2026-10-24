// Client-side diagnostics: everything interesting goes to the page server's /log (-> web-poc/client.log).
import { noPageServer } from './uisource';

const queue: string[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  if (!queue.length) return;
  if (noPageServer()) return void queue.splice(0); // bundled: no /log endpoint
  const body = queue.splice(0).join('\n');
  fetch('log', { method: 'POST', body }).catch(() => {});
}

function scrub(s: string) {
  return s.replace(/(api_key|ApiKey|Token)=([^&"\s]+)/gi, '$1=<redacted>').replace(/Token="[^"]*"/g, 'Token="<redacted>"');
}

export function log(...a: unknown[]) {
  const line = a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ');
  queue.push(scrub(line));
  if (timer === undefined) timer = window.setTimeout(flush, 250);
}

function safeJson(x: unknown) {
  try {
    if (x instanceof Error) return `${x.name}: ${x.message}\n${x.stack ?? ''}`;
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function installErrorHooks() {
  window.addEventListener('error', (e) => log('JS ERROR', e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack ?? ''));
  window.addEventListener('unhandledrejection', (e) => log('JS REJECTION', e.reason instanceof Error ? e.reason : String(e.reason)));
  const origErr = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    log('console.error', ...a);
    origErr(...a);
  };
  log('boot', navigator.userAgent, `${innerWidth}x${innerHeight}@${devicePixelRatio}`);
}
