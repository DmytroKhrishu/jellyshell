// "Downloads" tab: read-only view of the Sonarr/Radarr queue (live speed from qBittorrent) + recent imports,
// and a Calendar sub-tab (pages/DownloadsCalendar.tsx) with upcoming episode / movie release dates.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, IconName } from '../components/icons';
import { Img } from '../components/Img';
import { setBackdrop } from '../components/Backdrop';
import { DlItem, Downloads as DL, Recent, fmtAgo, fmtBytes, fmtEta, getDownloads } from '../lib/seerr';
import { useInitialFocus } from '../lib/useInitialFocus';
import { push } from '../lib/router';
import { focusEl } from '../lib/focus';
import { log } from '../lib/log';
import { DownloadsCalendar } from './DownloadsCalendar';

const STATUS_ICON: Record<DlItem['status'], IconName> = {
  downloading: 'downloads',
  queued: 'queued',
  importing: 'importing',
  stalled: 'alert',
  failed: 'alert',
};

const STATUS_LABEL: Record<DlItem['status'], string> = {
  downloading: 'Downloading',
  queued: 'Queued',
  importing: 'Importing',
  stalled: 'Stalled',
  failed: 'Failed',
};

/** ?dldemo=1 in the page URL shows sample rows (UI testing when nothing is downloading). */
const DEMO = new URLSearchParams(location.search).has('dldemo');

type Sub = 'queue' | 'calendar';
const SUBS: { id: Sub; label: string; icon: IconName }[] = [
  { id: 'queue', label: 'Queue', icon: 'downloads' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
];
/** Last sub-tab, per session (a fresh app start opens the queue). */
const SUB_KEY = 'jellyshell.dl.sub';
const savedSub = (): Sub => (sessionStorage.getItem(SUB_KEY) === 'calendar' ? 'calendar' : 'queue');

/** Row already in the library: A/click opens its detail page (series page on that season for episodes). */
function openLib(e: Event, r: { jellyfinId?: string; jellyfinSeasonId?: string | null }) {
  if (!r.jellyfinId) return;
  focusEl(e.currentTarget as HTMLElement, { instant: true }); // B on the detail page returns here
  push({ name: 'item', id: r.jellyfinId, seasonId: r.jellyfinSeasonId || undefined });
}

export function Downloads({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DL | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>(savedSub);
  const [calReady, setCalReady] = useState(false);
  const [calSummary, setCalSummary] = useState('');
  useInitialFocus(ref, active, sub === 'queue' ? !!data || !!err : calReady);
  const pick = (s: Sub) => {
    if (s === sub) return;
    sessionStorage.setItem(SUB_KEY, s);
    setSub(s);
    log('downloads sub', s);
  };

  useEffect(() => {
    if (active) setBackdrop(null, 0.6, 0);
  }, [active]);

  // Poll every 5 s while the tab is visible (and the app/page is visible).
  useEffect(() => {
    if (!active || sub !== 'queue') return;
    let alive = true;
    let t: number | undefined;
    const tick = () => {
      window.clearTimeout(t);
      if (document.hidden) {
        t = window.setTimeout(tick, 5000);
        return;
      }
      getDownloads(DEMO)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr(null);
          if (d.errors.length) log('downloads partial', d.errors);
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)))
        .finally(() => alive && (t = window.setTimeout(tick, 5000)));
    };
    tick();
    const vis = () => !document.hidden && tick();
    document.addEventListener('visibilitychange', vis);
    return () => {
      alive = false;
      window.clearTimeout(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [active, sub]);

  const items = data?.items ?? [];
  const recent = data?.recent ?? [];
  const totalSpeed = items.reduce((s, x) => s + (x.speed || 0), 0);

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="10rem" data-marginbottom="4rem" data-group="downloads">
      <div class="vtrack page-pad">
        <div class="lib-head dl-head" data-scrolltop>
          <h1>Downloads</h1>
          <div class="dl-subtabs" role="tablist" data-group="dl-sub">
            {SUBS.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={sub === t.id}
                class={'pill focusable' + (sub === t.id ? ' selected' : '')}
                tabIndex={-1}
                data-fkey={'dl-sub-' + t.id}
                onClick={() => pick(t.id)}
              >
                <Icon name={t.icon} />
                {t.label}
              </div>
            ))}
          </div>
          {sub === 'queue' && data && (
            <span class="count">
              {items.length ? `${items.length} in queue · ${fmtBytes(totalSpeed)}/s` : 'Idle'} · updates every 5 s
            </span>
          )}
          {sub === 'calendar' && calSummary && <span class="count">{calSummary}</span>}
        </div>
        {sub === 'calendar' && <DownloadsCalendar active={active} demo={DEMO} onReady={() => setCalReady(true)} onSummary={setCalSummary} />}
        {sub === 'queue' && (
          <>
        {err && <div class="rq-error">Couldn't load downloads: {err}</div>}
        {data?.errors.length ? <div class="muted dl-warn">Partial data: {data.errors.join(' · ')}</div> : null}
        {!data && !err && (
          <div class="dl-list">
            {[0, 1, 2].map((i) => (
              <div key={i} class="dl-row sk" style={{ height: '8.6rem' }} />
            ))}
          </div>
        )}
        {data && !items.length && (
          <div class="dl-empty focusable" tabIndex={-1} data-fkey="dl-empty" data-scrolltop>
            <div class="dl-empty-ico"><Icon name="downloads" /></div>
            <div class="dl-empty-title">Nothing is downloading</div>
            <div class="muted">Requested titles show up here while they download.</div>
          </div>
        )}
        {items.length > 0 && (
          <div class="dl-list" data-group="dl-active">
            {items.map((it) => (
              <DlRow key={it.id} it={it} />
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <section class="dl-recent" data-group="dl-recent" data-scrollunit>
            <h2 class="row-title">Recently imported</h2>
            <div class="dl-recent-grid">
              {recent.map((r) => (
                <RecentRow key={r.id} r={r} />
              ))}
            </div>
          </section>
        )}
          </>
        )}
      </div>
    </div>
  );
}

function DlRow({ it }: { it: DlItem }) {
  return (
    <div
      class={'dl-row focusable st-' + it.status + (it.jellyfinId ? ' linked' : '')}
      tabIndex={-1}
      data-fkey={'dl-' + it.id}
      data-scrollunit
      onClick={(e) => openLib(e, it)}
    >
      <div class="dl-poster">
        <Img src={it.poster} alt={it.title} />
      </div>
      <div class="dl-main">
        <div class="dl-top">
          <div class="dl-title">
            {it.title}
            {it.subtitle && <span class="dl-sub">{it.subtitle}</span>}
          </div>
          <div class={'dl-status ' + it.status}><Icon name={STATUS_ICON[it.status]} />{STATUS_LABEL[it.status]}</div>
          {it.jellyfinId && <div class="dl-open">In library <Icon name="chevRight" /></div>}
        </div>
        <div class="dl-bar">
          <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, it.percent / 100))})` }} />
        </div>
        <div class="dl-meta">
          <span class="dl-pct">{it.percent.toFixed(it.percent < 10 ? 1 : 0)}%</span>
          <span>
            {fmtBytes(Math.max(0, it.size - it.sizeLeft))} of {fmtBytes(it.size)}
          </span>
          {it.status === 'downloading' && <span>{fmtBytes(it.speed)}/s</span>}
          {(it.status === 'downloading' || it.status === 'stalled') && <span>ETA {fmtEta(it.eta)}</span>}
          {it.quality && <span class="badge">{it.quality}</span>}
          {it.message && <span class="dl-msg">{it.message}</span>}
        </div>
      </div>
    </div>
  );
}

function RecentRow({ r }: { r: Recent }) {
  return (
    <div class={'dl-recent-row focusable' + (r.jellyfinId ? ' linked' : '')} tabIndex={-1} data-fkey={'dlr-' + r.id} onClick={(e) => openLib(e, r)}>
      <div class="dl-poster small">
        <Img src={r.poster} alt={r.title} />
      </div>
      <div class="dl-main">
        <div class="dl-title">{r.title}</div>
        <div class="dl-sub2">{[r.subtitle, r.quality].filter(Boolean).join(' · ')}</div>
        <div class="dl-sub2 muted">{r.date ? fmtAgo(r.date) : ''}</div>
      </div>
      {r.jellyfinId && <div class="dl-chev"><Icon name="chevRight" /></div>}
    </div>
  );
}
