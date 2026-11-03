// Network lock + mocks for the headless app tests. Every request the page makes goes through one route handler:
//   - Vite's own assets on the app origin are let through,
//   - mocked endpoints are fulfilled (page server /api/*, /log, the fake Jellyfin at http://jf.test),
//   - everything else is ABORTED and listed in `blocked`. Nothing can reach a live JellyShell, Dash, Jellyfin or Seerr.
import type { BrowserContext, Request } from '@playwright/test';

export const WEB = `http://127.0.0.1:${Number(process.env.JS_TEST_WEB_PORT) || 5391}`;
export const DASH = `http://127.0.0.1:${Number(process.env.JS_TEST_DASH_PORT) || 5392}`;
export const JF = 'http://jf.test';

export interface Mock {
  status?: number;
  json?: unknown;
  body?: string | Buffer;
  contentType?: string;
  delayMs?: number;
}
export type Handler = (url: URL, req: Request) => Mock | undefined;

// 1x1 transparent PNG for image endpoints.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function lockNetwork(context: BrowserContext, appOrigin: string, handlers: Handler[]) {
  const blocked: string[] = [];
  const writes: string[] = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && !(url.origin === appOrigin && url.pathname === '/log')) writes.push(`${req.method()} ${url.pathname}${url.search}`);
    for (const h of handlers) {
      const m = h(url, req);
      if (!m) continue;
      if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs));
      if (m.json !== undefined) return route.fulfill({ status: m.status ?? 200, contentType: 'application/json', body: JSON.stringify(m.json) });
      return route.fulfill({ status: m.status ?? 200, contentType: m.contentType, body: m.body ?? '' });
    }
    if (url.origin === appOrigin && !url.pathname.startsWith('/api/') && url.pathname !== '/log') return route.continue();
    blocked.push(`${req.method()} ${req.url()}`);
    return route.abort('blockedbyclient');
  });
  return { blocked, writes };
}

/** The page server's debug remote (GET api/cmd?c=NAME, polled every second): hands out `cmds` one per poll. */
export function pageServer(appOrigin: string, cmds: unknown[], extra: Record<string, unknown> = {}): Handler {
  const queue = [...cmds];
  return (url) => {
    if (url.origin !== appOrigin) return;
    if (url.pathname === '/log') return { status: 204 };
    if (url.pathname === '/api/cmd') return { json: queue.shift() ?? null };
    if (url.pathname in extra) return { json: extra[url.pathname] };
    if (url.pathname.startsWith('/api/')) return { status: 404, json: { error: 'not mocked' } };
  };
}
