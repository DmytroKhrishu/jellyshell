// Downloads → Calendar sub-tab: Sonarr episode air dates + Radarr cinema/digital/physical release dates as an agenda,
// grouped by day in the household zone (lib/clock.ts). Read-only. Rows already in the library open the item.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon, IconName } from '../components/icons';
import { Img } from '../components/Img';
import { CalEvent, getCalendar } from '../lib/seerr';
import { addDays, dayKey, fmtDayDate, fmtTime, relDay } from '../lib/clock';
import { focusEl, remember } from '../lib/focus';
import { push } from '../lib/router';
import { log } from '../lib/log';
import '../styles/calendar.css';

/** Range shown: a week back (recent releases you may still want) to six weeks ahead. */
const BACK_DAYS = 7;
const AHEAD_DAYS = 42;

const KIND: Record<CalEvent['kind'], { icon: IconName; label: string }> = {
  episode: { icon: 'shows', label: 'Episode' },
  cinema: { icon: 'cinema', label: 'In cinemas' },
  digital: { icon: 'digital', label: 'Digital' },
  physical: { icon: 'physical', label: 'Disc' },
};

/**
 * TV/desktop (transform scroller): put the Today heading at the page's top margin, so D-pad Down from the sub-tab
 * pills (or the first focus on the tab) shows Today and what's next instead of parking the anchor row at the bottom
 * edge under a week of past rows. Writes the same transform + data-ty the focus engine uses (lib/focus.ts setTy).
 */
function scrollToToday(list: HTMLElement) {
  const v = list.closest<HTMLElement>('[data-vscroll]');
  const track = v?.firstElementChild as HTMLElement | null;
  const sec = list.querySelector<HTMLElement>('.cal-day.today');
  const root = document.documentElement;
  // Phones scroll natively; a mouse hover must never yank the page out from under the pointer.
  if (!v || !track || !sec || root.classList.contains('mode-mobile') || root.classList.contains('mouse')) return;
  const cur = parseFloat(track.dataset.ty || '0');
  const y = sec.getBoundingClientRect().top - track.getBoundingClientRect().top;
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const top = parseFloat(v.dataset.margintop || '10') * remPx;
  const ny = Math.min(Math.max(0, track.scrollHeight - v.clientHeight), Math.max(0, y - top));
  if (Math.abs(ny - cur) < 2) return;
  track.style.transform = `translate3d(0,${-ny}px,0)`;
  track.dataset.ty = String(ny);
}

function openLib(e: Event, r: CalEvent) {
  if (!r.jellyfinId) return;
  focusEl(e.currentTarget as HTMLElement, { instant: true }); // B on the detail page returns here
  push({
    name: 'item',
    id: r.jellyfinId,
    seasonId: r.jellyfinSeasonId || undefined,
  });
}

export function DownloadsCalendar({
  active,
  demo,
  onReady,
  onSummary,
}: {
  active: boolean;
  demo: boolean;
  /** Called once the first answer (data or error) is in, so the page can run its initial focus. */
  onReady: () => void;
  onSummary: (s: string) => void;
}) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const today = dayKey();
  const listRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  // Fetch on every activation (the proxy caches 60 s), keeping the old list while it reloads.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const t = dayKey();
    getCalendar(addDays(t, -BACK_DAYS), addDays(t, AHEAD_DAYS), demo)
      .then((d) => {
        if (!alive) return;
        setEvents(d.events);
        setErrors(d.errors);
        setErr(null);
        if (d.errors.length) log('calendar partial', d.errors);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)))
      .finally(() => alive && onReady());
    return () => {
      alive = false;
    };
  }, [active, demo]);

  // Day groups; Today always gets a section so the list has an anchor even on a quiet day.
  const days = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date)!.push(e);
    }
    if (events && !m.has(today)) m.set(today, []);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [events, today]);

  // The first event on/after today is the anchor: it gets data-autofocus (initial focus) and becomes the
  // calendar group's remembered child, so D-pad Down from the sub-tab pills lands on Today, not a week ago.
  const anchorId = useMemo(() => {
    const all = (events ?? []).filter((e) => e.date >= today);
    return all[0]?.id ?? events?.[events.length - 1]?.id ?? null;
  }, [events, today]);

  useEffect(() => {
    if (!events) return;
    const n = events.length;
    const upcoming = events.filter((e) => e.date >= today).length;
    onSummary(n ? `${upcoming} upcoming · ${n - upcoming} in the last week` : 'Nothing scheduled');
  }, [events, today]);

  useEffect(() => {
    const list = listRef.current;
    if (!events || !list) return;
    const anchor = list.querySelector<HTMLElement>('[data-autofocus]');
    remember(anchor);
    // Phone / touch (native scroll, nothing focused): put Today at the top once.
    if (!placed.current && document.documentElement.classList.contains('mode-mobile')) {
      placed.current = true;
      const sec = list.querySelector<HTMLElement>(`[data-day="${today}"]`);
      const v = list.closest<HTMLElement>('[data-vscroll]');
      if (sec && v) v.scrollTop = Math.max(0, sec.offsetTop - 12);
    }
  }, [events]);

  return (
    <>
      {err && <div class="rq-error">Couldn't load the calendar: {err}</div>}
      {errors.length ? <div class="muted dl-warn">Partial data: {errors.join(' · ')}</div> : null}
      {!events && !err && (
        <div class="cal-list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} class="cal-row sk" style={{ height: '6.6rem' }} />
          ))}
        </div>
      )}
      {events && (
        <div class="cal-list" ref={listRef} data-group="cal">
          {days.map(([day, evs]) => (
            <section key={day} class={'cal-day' + (day < today ? ' past' : '') + (day === today ? ' today' : '')} data-day={day}>
              {evs.length === 0 ? (
                <div data-scrollunit>
                  <DayHead day={day} n={0} />
                  <div class="cal-none muted">Nothing releasing today</div>
                </div>
              ) : (
                evs.map((e, i) =>
                  i === 0 ? (
                    // The day heading scrolls with its first row, so a focused row never hides its date.
                    <div key={e.id} data-scrollunit>
                      <DayHead day={day} n={evs.length} />
                      <CalRow e={e} anchor={e.id === anchorId} list={listRef} />
                    </div>
                  ) : (
                    <div key={e.id} data-scrollunit>
                      <CalRow e={e} anchor={e.id === anchorId} list={listRef} />
                    </div>
                  ),
                )
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function DayHead({ day, n }: { day: string; n: number }) {
  const rel = relDay(day);
  return (
    <h2 class="cal-dayhead">
      <span class="cal-rel">{rel ?? fmtDayDate(day)}</span>
      {rel && <span class="cal-date">{fmtDayDate(day)}</span>}
      {n > 1 && <span class="cal-n">{n} releases</span>}
    </h2>
  );
}

function CalRow({ e, anchor, list }: { e: CalEvent; anchor: boolean; list: { current: HTMLElement | null } }) {
  const k = KIND[e.kind];
  const multi = (e.count ?? 1) > 1;
  const state = e.hasFile
    ? { cls: 'have', icon: 'watched' as IconName, label: 'Downloaded' }
    : multi && e.filesHave
      ? {
          cls: 'part',
          icon: 'partial' as IconName,
          label: `${e.filesHave}/${e.count} downloaded`,
        }
      : e.date > dayKey() || (e.at && Date.parse(e.at) > Date.now())
        ? { cls: 'soon', icon: 'clock' as IconName, label: 'Upcoming' }
        : { cls: 'miss', icon: 'alert' as IconName, label: 'Missing' };
  return (
    <div
      class={'cal-row focusable k-' + e.kind + (e.jellyfinId ? ' linked' : '')}
      tabIndex={-1}
      data-fkey={'cal-' + e.id}
      data-autofocus={anchor || undefined}
      onClick={(ev) => openLib(ev, e)}
      onFocus={
        anchor
          ? (ev: FocusEvent) => {
              // Arriving from the header / tab bar / nowhere (first focus): jump to Today. Row-to-row moves keep the normal reveal.
              const from = ev.relatedTarget as HTMLElement | null;
              if (!from || !list.current?.contains(from)) requestAnimationFrame(() => list.current && scrollToToday(list.current));
            }
          : undefined
      }
    >
      <div class="dl-poster cal-poster">
        <Img src={e.poster} alt={e.title} />
      </div>
      <div class="cal-main">
        <div class="cal-title">{e.title}</div>
        <div class="cal-sub">{e.subtitle}</div>
      </div>
      <div class="cal-side">
        <div class="cal-when">
          <span class={'cal-kind k-' + e.kind}>
            <Icon name={k.icon} />
            {k.label}
          </span>
          {e.at && <span class="cal-time">{fmtTime(Date.parse(e.at))}</span>}
        </div>
        <div class={'cal-state ' + state.cls}>
          <Icon name={state.icon} />
          {state.label}
        </div>
      </div>
      {e.jellyfinId ? (
        <div class="dl-chev">
          <Icon name="chevRight" />
        </div>
      ) : (
        <div class="dl-chev ghost" />
      )}
    </div>
  );
}
