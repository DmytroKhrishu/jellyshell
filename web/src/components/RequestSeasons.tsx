// "Request more seasons" on a library series page (show partly downloaded): a button in the header row + a modal
// with the seasons Seerr can still request. Seasons already in Jellyfin, available/partial in Seerr or already
// requested are shown locked. Same proxy route as the Requests tab (POST api/seerr/request, the proxy re-checks
// which seasons are free and refuses duplicates with 409).
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Icon } from './icons';
import { showToast } from './Dialog';
import { Item } from '../lib/jellyfin';
import { SDetail, Me, ServerOpts, AVAIL_LABEL, Avail, createRequest, getDetail, me as getMe, requestOptions, titleOf } from '../lib/seerr';
import { seerrRows } from '../lib/franchise';
import { caps } from '../lib/caps';
import { focusEl, focusFirst } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { log } from '../lib/log';
import { CHIP_ICON, seasonState, ReqPick, defaultPick, advancedBody, RequestOptions } from '../pages/Requests';
import '../styles/requests.css';
import '../styles/tmdb.css';
import '../styles/request-seasons.css';

type SState = Avail | 'library';
interface SeasonRow {
  n: number;
  episodes: number;
  st: SState;
  unaired: boolean;
}

let meCache: Promise<Me> | null = null;

function rowsFor(d: SDetail, jfSeasons: Item[]): SeasonRow[] {
  const st = seasonState(d);
  const inJf = new Set(jfSeasons.map((s) => s.IndexNumber ?? -1));
  const today = new Date().toISOString().slice(0, 10);
  return (d.seasons ?? [])
    .filter((s) => s.seasonNumber > 0)
    .map((s) => {
      const a = st(s.seasonNumber);
      // Seerr out of sync with the library (show added by hand, scan pending): Jellyfin's own seasons win.
      const lib = a === 'none' && inJf.has(s.seasonNumber);
      return { n: s.seasonNumber, episodes: s.episodeCount, st: lib ? 'library' : a, unaired: !s.airDate || s.airDate > today };
    });
}

const LABEL: Record<SState, string> = { ...AVAIL_LABEL, library: 'In library' };
const fmtList = (ns: number[]) => {
  // 3,4,5,6,8 -> "3–6, 8"
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j - i >= 2 ? `${ns[i]}–${ns[j]}` : j > i ? `${ns[i]}, ${ns[j]}` : `${ns[i]}`);
    i = j;
  }
  return out.join(', ');
};

/** Header button for a library series; renders nothing unless Seerr has seasons left to request. */
export function RequestSeasonsButton({ series, jfSeasons }: { series: Item; jfSeasons: Item[] | undefined }) {
  const tmdb = Number((series as Item & { ProviderIds?: Record<string, string> }).ProviderIds?.Tmdb) || null;
  const enabled = !!tmdb && seerrRows() && caps.value?.requests !== false;
  const [d, setD] = useState<SDetail | null>(null);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLDivElement>(null);

  const load = () => getDetail('tv', tmdb!).then(setD, (e) => log('request seasons: detail failed', String(e)));
  useEffect(() => {
    setD(null);
    if (enabled) load();
  }, [tmdb, enabled]);

  if (!enabled || !d || !jfSeasons) return null;
  const rows = rowsFor(d, jfSeasons);
  const free = rows.filter((r) => r.st === 'none');
  if (!free.length) return null;

  const close = (changed?: boolean) => {
    setOpen(false);
    if (changed) load();
    requestAnimationFrame(() => {
      // the button may be gone if nothing is left to request
      if (!btn.current?.isConnected || !focusEl(btn.current, { instant: true })) focusFirst(document.querySelector('.page.active') ?? document.body);
    });
  };

  return (
    <>
      <div class="btn focusable" tabIndex={-1} data-fkey="act-reqseasons" ref={btn} onClick={() => setOpen(true)} title={`${free.length} season${free.length === 1 ? '' : 's'} not in the library`}>
        <Icon name="requests" />
        Request more seasons
      </div>
      {open &&
        createPortal(
          <RequestSeasonsModal series={series} tmdb={tmdb!} d={d} rows={rows} onClose={close} />,
          document.getElementById('app') ?? document.body,
        )}
    </>
  );
}

function RequestSeasonsModal(p: { series: Item; tmdb: number; d: SDetail; rows: SeasonRow[]; onClose: (changed?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const free = p.rows.filter((r) => r.st === 'none').map((r) => r.n);
  // Pre-select the aired missing seasons; unaired ones only if nothing else is left.
  const aired = p.rows.filter((r) => r.st === 'none' && !r.unaired).map((r) => r.n);
  const [sel, setSel] = useState<Set<number>>(() => new Set(aired.length ? aired : free));
  const [user, setUser] = useState<Me | null>(null);
  const [opts, setOpts] = useState<ServerOpts[] | null>(null);
  const [pick, setPick] = useState<ReqPick | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const title = titleOf(p.d) || p.series.Name;

  useEffect(() => {
    (meCache ??= getMe()).then(setUser, () => (meCache = null));
  }, []);
  useEffect(() => {
    if (!user?.advanced || opts) return;
    requestOptions('tv').then(
      (r) => {
        setOpts(r.advanced ? r.servers : []);
        if (r.advanced && r.servers[0]) setPick(defaultPick(r.servers[0]));
      },
      (e) => (log('request options failed', String(e)), setOpts([])),
    );
  }, [user?.advanced]);

  // First focus: the first missing season (not the Request button, so a double A can't file a request).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('.rqm-season.free');
      if (!focusEl(first, { instant: true })) focusFirst(ref.current, { instant: true });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // B closes; shoulder buttons / X / Y / Menu / View are swallowed so the page underneath doesn't react (LB/RB = season switch).
  useEffect(
    () =>
      pushHandler((e) => {
        switch (e.action) {
          case 'back':
            if (!e.repeat && !sending) p.onClose();
            return true;
          case 'lb':
          case 'rb':
          case 'x':
          case 'y':
          case 'menu':
          case 'view':
            return true;
        }
        return false;
      }),
    [sending],
  );

  const all = free.length > 0 && free.every((n) => sel.has(n));
  const toggle = (n: number) => {
    const s = new Set(sel);
    if (s.has(n)) s.delete(n);
    else s.add(n);
    setSel(s);
  };
  const picked = [...sel].filter((n) => free.includes(n)).sort((a, b) => a - b);
  const server = opts?.find((s) => s.id === pick?.serverId) ?? null;

  const submit = async () => {
    if (sending || !picked.length) return;
    setSending(true);
    setErr(null);
    try {
      const adv = advancedBody(server, pick, 'tv');
      const r = await createRequest({ mediaType: 'tv', mediaId: p.tmdb, seasons: picked, ...adv });
      const what = `${picked.length === 1 ? 'Season' : 'Seasons'} ${fmtList(picked)}`;
      showToast(r.attributed ? `${what} requested as ${r.attributedTo}` : `${what} requested (filed by the server admin)`, 4000);
      log('seerr request created', { id: r.request.id, type: 'tv', tmdb: p.tmdb, seasons: picked, adv, from: 'series page' });
      p.onClose(true);
    } catch (e: any) {
      log('seerr request failed', String(e?.message ?? e));
      setErr(`Request failed: ${e?.message ?? e}`);
      setSending(false);
    }
  };

  const nLib = p.rows.filter((r) => r.st !== 'none').length;
  return (
    <div class="dialog-wrap rq-confirm-wrap">
      <div class={'dialog rq-confirm rqm' + (server ? ' with-opts' : '')} data-scope ref={ref}>
        <div class="dialog-col">
          <h3>
            <Icon name="requests" />
            Request more seasons
          </h3>
          <div class="rq-confirm-text">
            {title}
            <div class="muted">
              {nLib ? `${nLib} of ${p.rows.length} seasons are in the library or already requested. ` : ''}
              Pick the ones to download. {user ? (user.attributed ? `Filed as ${user.displayName}.` : 'Filed by the server admin.') : ''}
            </div>
          </div>
          <div class="rq-seasons rqm-seasons" data-group="rqm-seasons">
            {free.length > 1 && (
              <div class={'pill focusable' + (all ? ' selected' : '')} tabIndex={-1} data-fkey="rqm-all" onClick={() => setSel(all ? new Set() : new Set(free))}>
                {all && <Icon name="check" />}All missing
              </div>
            )}
            {p.rows.map((r) => {
              const isFree = r.st === 'none';
              const on = isFree && sel.has(r.n);
              const icon = r.st === 'available' || r.st === 'library' ? 'watched' : r.st === 'none' ? null : CHIP_ICON[r.st];
              return (
                <div
                  key={r.n}
                  class={'pill rq-season rqm-season focusable' + (isFree ? ' free' : ' locked ' + (r.st === 'library' ? 'available' : r.st)) + (on ? ' selected' : '')}
                  tabIndex={-1}
                  data-fkey={'rqm-s-' + r.n}
                  title={LABEL[r.st]}
                  onClick={() => isFree && toggle(r.n)}
                >
                  {isFree ? on && <Icon name="check" /> : icon && <Icon name={icon} />}
                  S{r.n}
                  <small>{isFree ? (r.unaired ? 'Not aired' : `${r.episodes} ep`) : LABEL[r.st]}</small>
                </div>
              );
            })}
          </div>
          {server && pick && <RequestOptions type="tv" servers={opts!} server={server} pick={pick} onPick={setPick} />}
          {err && <div class="err rq-err">{err}</div>}
          <div class="btn-row" data-group="rqm-actions">
            <div class="btn focusable" tabIndex={-1} data-fkey="rqm-cancel" onClick={() => !sending && p.onClose()}>
              Cancel
            </div>
            <div class={'btn focusable' + (picked.length ? '' : ' disabled')} tabIndex={-1} data-fkey="rqm-request" onClick={submit}>
              {sending ? <span class="spinner" /> : <Icon name="requests" />}
              {sending ? 'Requesting…' : picked.length ? `Request ${picked.length} season${picked.length === 1 ? '' : 's'}` : 'Pick a season'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
