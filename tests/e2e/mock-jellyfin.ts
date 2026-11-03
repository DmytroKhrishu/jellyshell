// A tiny fake Jellyfin for the series page: one show, four seasons of 12 episodes, Next Up = S3E05.
import { JF, PNG, type Handler } from './net';

export const SERIES = 'SER1';
export const UP_NEXT = 'S3E05';
const TICKS_MIN = 600_000_000;

const series = { Id: SERIES, Name: 'Mock Show', Type: 'Series', ChildCount: 4, ProductionYear: 2020, Overview: 'A show that only exists in tests.', UserData: {}, ImageTags: {}, People: [] };
const seasons = [1, 2, 3, 4].map((n) => ({ Id: `S${n}`, Name: `Season ${n}`, Type: 'Season', IndexNumber: n, SeriesId: SERIES, UserData: { Played: n < 3 }, ImageTags: {} }));
const episode = (s: number, e: number) => ({
  Id: `S${s}E${String(e).padStart(2, '0')}`,
  Name: `Episode ${e}`,
  Type: 'Episode',
  SeriesId: SERIES,
  SeriesName: series.Name,
  SeasonId: `S${s}`,
  ParentIndexNumber: s,
  IndexNumber: e,
  RunTimeTicks: 42 * TICKS_MIN,
  Overview: 'Something happens.',
  UserData: { Played: s < 3 || (s === 3 && e < 5) },
  ImageTags: {},
});
const episodesOf = (s: number) => Array.from({ length: 12 }, (_, i) => episode(s, i + 1));
const list = (Items: unknown[]) => ({ Items, TotalRecordCount: Items.length });

/** `nextUpDelayMs`: answer the series' Next Up later than its seasons (the race that picked Season 1, 28e3545). */
export function mockJellyfin(opts: { nextUpDelayMs?: number } = {}): Handler {
  return (url) => {
    if (url.origin !== JF) return;
    const p = url.pathname;
    const q = url.searchParams;
    if (/\/Images\//.test(p)) return { body: PNG, contentType: 'image/png' };
    if (p === '/System/Info/Public') return { json: { ServerName: 'Mock', Version: '10.11.0', Id: 'mock' } };
    if (p === '/Items/Latest') return { json: [] };
    if (p === '/UserViews' || p === '/UserItems/Resume') return { json: list([]) };
    if (p === '/Shows/NextUp') return q.get('seriesId') === SERIES ? { json: list([episode(3, 5)]), delayMs: opts.nextUpDelayMs } : { json: list([]) };
    if (p === `/Shows/${SERIES}/Seasons`) return { json: list(seasons) };
    if (p === `/Shows/${SERIES}/Episodes`) return { json: list(episodesOf(Number(q.get('seasonId')?.slice(1)) || 1)) };
    if (/^\/Items\/[^/]+\/Similar$/.test(p)) return { json: list([]) };
    const m = p.match(/^\/Items\/([^/]+)$/);
    if (m) {
      if (m[1] === SERIES) return { json: series };
      const e = m[1].match(/^S(\d)E(\d\d)$/);
      if (e) return { json: episode(+e[1], +e[2]) };
    }
    if (p === '/Items') return { json: list([]) };
    return { status: 404, json: { error: `mock Jellyfin: ${p} not mocked` } };
  };
}

export const authInit = (server: string) => {
  localStorage.setItem('jellyshell.auth.v1', JSON.stringify({ server, token: 'test-token', userId: 'test-user', userName: 'Test', serverName: 'Mock' }));
};
