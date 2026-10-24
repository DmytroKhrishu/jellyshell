// Person page (actor / director): photo, facts, biography, "In your library" + Seerr filmography rows.
// Route { name: 'person'; jfId?; tmdbId? }. Library credits open the Jellyfin item; others open the TMDB page.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { setBackdrop } from '../components/Backdrop';
import { Card, Row } from '../components/Card';
import { Img } from '../components/Img';
import { Icon } from '../components/icons';
import { CreditCard, initials } from '../components/PersonCard';
import { openItem } from '../lib/actions';
import { fmtLongDate as fmtDate, yearsBetween } from '../lib/clock';
import { current, focusFirst } from '../lib/focus';
import { pushHandler } from '../lib/input';
import { Credit, loadPerson, Person as P } from '../lib/person';
import { push } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import '../styles/person.css';

export function Person({ jfId, tmdbId, active }: { jfId?: string; tmdbId?: number; active: boolean }) {
  const { data, error } = useAsync(() => loadPerson(jfId, tmdbId), [jfId, tmdbId]);
  const ref = useRef<HTMLDivElement>(null);
  const gid = 'person-' + (jfId ?? tmdbId);

  useEffect(() => {
    if (active && data) setBackdrop(data.person.backdrop ?? null, 0.7, 0);
  }, [active, data]);

  useEffect(() => {
    if (!active || !data) return;
    const id = requestAnimationFrame(() => {
      const cur = current();
      if (!cur || !ref.current?.contains(cur)) focusFirst(ref.current, { instant: true });
    });
    return () => cancelAnimationFrame(id);
  }, [active, data]);

  if (error) return <div class="page-pad err">Couldn't load this person: {error.message}</div>;
  if (!data) return <PersonSkeleton />;

  const open = (c: Credit) => {
    if (c.lib) openItem(c.lib);
    else push({ name: 'tmdb', type: c.type, id: c.tmdbId });
  };
  const { person, library, movies, shows } = data;
  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="8rem" data-marginbottom="5rem" data-group={gid}>
      <div class="vtrack page-pad pp-page">
        <Hero p={person} active={active} />
        {data.seerrError && !movies.length && !shows.length && (
          <div class="pp-note muted">Full filmography unavailable ({data.seerrError}).</div>
        )}
        {library.length > 0 && (
          <Row title="In your library" id={gid + '-lib'}>
            {library.map((it) => (
              <Card key={it.Id} item={it} kind="poster" fkey={'pp-lib-' + it.Id} onSelect={(x) => openItem(x)} />
            ))}
          </Row>
        )}
        {movies.length > 0 && <CreditRow title="Movies" id={gid + '-movies'} credits={movies} onSelect={open} />}
        {shows.length > 0 && <CreditRow title="Shows" id={gid + '-shows'} credits={shows} onSelect={open} />}
        {!library.length && !movies.length && !shows.length && <div class="pp-note muted">No titles found for {person.name}.</div>}
      </div>
    </div>
  );
}

function CreditRow({ title, id, credits, onSelect }: { title: string; id: string; credits: Credit[]; onSelect: (c: Credit) => void }) {
  return (
    <section class="row row-poster pp-row" data-group={id} data-scrollunit>
      <h2 class="row-title">{title}</h2>
      <div class="row-viewport" data-hscroll>
        <div class="row-track">
          {credits.map((c) => (
            <CreditCard key={c.key} c={c} fkey={'pp-' + c.key} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </section>
  );
}

const DEPT: Record<string, string> = { Acting: 'Actor', Directing: 'Director', Writing: 'Writer', Production: 'Producer', Sound: 'Composer', Camera: 'Cinematographer', Editing: 'Editor' };

function Hero({ p, active }: { p: P; active: boolean }) {
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const bioRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const born = fmtDate(p.birthday);
  const died = fmtDate(p.deathday);
  const age = yearsBetween(p.birthday, p.deathday);

  // Show "More" only when the text actually overflows the clamp.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !more) setClamped(el.scrollHeight > el.clientHeight + 2);
  }, [p.bio, more]);

  // Expanded bio is a capped box: Up/Down scroll inside it first, then move focus on at the edges
  // (so the focused element never leaves the screen on TV).
  useEffect(() => {
    if (!active || !more) return;
    return pushHandler((e) => {
      const el = bioRef.current;
      if (!el || current() !== el || (e.action !== 'up' && e.action !== 'down')) return false;
      const step = el.clientHeight * 0.6;
      const max = el.scrollHeight - el.clientHeight;
      if (e.action === 'down' && el.scrollTop < max - 1) return el.scrollBy({ top: step, behavior: 'smooth' }), true;
      if (e.action === 'up' && el.scrollTop > 1) return el.scrollBy({ top: -step, behavior: 'smooth' }), true;
      return false;
    });
  }, [active, more]);

  const toggle = () => {
    if (!clamped && !more) return;
    setMore((m) => !m);
    if (bioRef.current) bioRef.current.scrollTop = 0;
  };
  // Mouse wheel over the open bio scrolls the text, not the page.
  const onWheel = (e: WheelEvent) => {
    const el = bioRef.current;
    if (!more || !el || el.scrollHeight <= el.clientHeight) return;
    e.stopPropagation();
  };

  return (
    <div class="pp-hero" data-scrolltop>
      <div class="pp-photo">
        <Img src={p.photo} alt={initials(p.name)} />
      </div>
      <div class="pp-info">
        {p.knownFor && <div class="hero-kicker">{DEPT[p.knownFor] ?? p.knownFor}</div>}
        <div class="detail-title pp-name fade-swap">{p.name}</div>
        <div class="pp-facts">
          {born && (
            <span>
              <Icon name="born" /> Born {born}
              {age !== null && !died ? ` (age ${age})` : ''}
            </span>
          )}
          {died && (
            <span>
              Died {died}
              {age !== null ? ` (aged ${age})` : ''}
            </span>
          )}
          {p.place && (
            <span>
              <Icon name="place" /> {p.place}
            </span>
          )}
        </div>
        {p.bio && (
          <div class="pp-bio-wrap" data-group="pp-bio">
            <div
              ref={bioRef}
              class={'pp-bio' + (more ? ' open' : '') + (clamped || more ? ' focusable' : '')}
              tabIndex={-1}
              data-fkey="pp-bio"
              data-autofocus={clamped || more || undefined}
              role={clamped || more ? 'button' : undefined}
              aria-expanded={clamped || more ? more : undefined}
              onClick={toggle}
              onWheel={onWheel}
            >
              <div ref={textRef} class="pp-bio-text">
                {p.bio}
              </div>
            </div>
            {(clamped || more) && (
              <div class="pp-more" aria-hidden="true">
                <Icon name={more ? 'chevUp' : 'chevDown'} />
                {more ? 'Less' : 'More'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PersonSkeleton() {
  return (
    <div class="page-pad pp-page">
      <div class="pp-hero">
        <div class="pp-photo sk" />
        <div class="pp-info">
          <div class="sk" style={{ width: '26rem', height: '4.4rem', marginBottom: '1.2rem' }} />
          <div class="sk" style={{ width: '20rem', height: '1.4rem', marginBottom: '1.2rem' }} />
          <div class="sk" style={{ width: '44rem', height: '7rem' }} />
        </div>
      </div>
    </div>
  );
}
