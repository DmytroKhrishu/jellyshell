import { calendar, now, hm, relDay, until, type CalEvent, ago } from '../lib/data';
import { QR } from '../components/charts';
import { Video, MapPin } from 'lucide-preact';
import { useState } from 'preact/hooks';

export function Calendar() {
  const cal = calendar.value;
  const d = now.value;
  const [sel, setSel] = useState<CalEvent | null>(null);
  if (!cal) return <div class="page-pad muted">Loading…</div>;

  const days: { key: string; date: Date; events: CalEvent[] }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + i);
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const evs = cal.events
      .filter((e) => new Date(e.start) < end && new Date(e.end) > day && (i > 0 || e.allDay || new Date(e.end) > d))
      .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || +new Date(a.start) - +new Date(b.start));
    days.push({ key: day.toDateString(), date: day, events: evs });
  }
  const focus = sel ?? cal.events.find((e) => !e.allDay && new Date(e.end) > d) ?? null;

  return (
    <div class="page-pad cal-page">
      <div class="cal-head">
        <h1 class="page-title">Calendar</h1>
        <div class="muted">{cal.mock ? 'Sample data — the Mac agent is not connected yet' : `Synced from Mac · ${ago(cal.updatedAt)}`}</div>
      </div>
      <div class="cal-layout">
        <div class="agenda" data-group="agenda">
          {days.map((day) => (
            <section class="agenda-day">
              <h2 class="agenda-date">
                {relDay(day.date, d)} <span class="muted">{day.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</span>
              </h2>
              {day.events.length === 0 && <div class="muted agenda-empty">No events</div>}
              {day.events.map((e) => {
                const st = new Date(e.start);
                const past = new Date(e.end) < d;
                return (
                  <button class={'agenda-ev focusable' + (past ? ' past' : '')} onFocus={() => setSel(e)} onClick={() => setSel(e)}>
                    <span class="ev-bar" style={{ background: e.color }} />
                    <span class="agenda-time">{e.allDay ? 'All day' : `${hm(st)} – ${hm(new Date(e.end))}`}</span>
                    <span class="agenda-title">{e.title}</span>
                    <span class="agenda-meta dim">
                      {e.url && <Video size="1em" />}
                      {e.calendar}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <aside class="ev-detail glass">
          {focus ? (
            <>
              <div class="detail-cal" style={{ color: focus.color }}>{focus.calendar}</div>
              <h2 class="detail-title">{focus.title}</h2>
              <div class="detail-time">
                {focus.allDay ? relDay(new Date(focus.start), d) + ' · all day' : `${relDay(new Date(focus.start), d)} · ${hm(new Date(focus.start))} – ${hm(new Date(focus.end))}`}
              </div>
              {!focus.allDay && new Date(focus.start) > d && <div class="detail-until">{until(new Date(focus.start), d)}</div>}
              {focus.location && <div class="detail-row"><MapPin size="1.1em" /> {focus.location}</div>}
              {focus.url && (
                <div class="detail-qr">
                  <QR text={focus.url} />
                  <div class="dim">Scan to join on your phone<br /><span class="muted small">{focus.url.replace(/^https?:\/\//, '')}</span></div>
                </div>
              )}
            </>
          ) : (
            <div class="muted">No upcoming events</div>
          )}
        </aside>
      </div>
    </div>
  );
}
