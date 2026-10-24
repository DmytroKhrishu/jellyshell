import { useEffect, useRef, useState } from 'preact/hooks';
import { Card } from '../components/Card';
import { setBackdrop } from '../components/Backdrop';
import { TextField } from './Login';
import { Item, backdropUrl, search } from '../lib/jellyfin';
import { useInitialFocus } from '../lib/useInitialFocus';
import { openItem, playItem } from '../lib/actions';
import { pushHandler } from '../lib/input';
import { uiMode } from '../lib/mode';

export function Search({ active }: { active: boolean }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useInitialFocus(ref, active, true);

  useEffect(() => {
    if (active) setBackdrop(null, 0.6, 0);
  }, [active]);

  // Live results, debounced ~300 ms (spec a6).
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRes(null);
      return;
    }
    setBusy(true);
    const t = window.setTimeout(() => {
      search(term)
        .then((r) => setRes(r.Items))
        .catch(() => setRes([]))
        .finally(() => setBusy(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Y = jump to the search field.
  useEffect(() => {
    if (!active) return;
    return pushHandler((e) => {
      if (e.action === 'y') {
        const input = ref.current?.querySelector<HTMLInputElement>('input');
        input?.focus();
        return true;
      }
      return false;
    });
  }, [active]);

  const movies = res?.filter((i) => i.Type === 'Movie') ?? [];
  const shows = res?.filter((i) => i.Type === 'Series') ?? [];
  const eps = res?.filter((i) => i.Type === 'Episode') ?? [];

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="10rem" data-group="search">
      <div class="vtrack page-pad">
        <div data-scrolltop style={{ maxWidth: '60rem', margin: '0 auto 2.4rem' }}>
          <TextField label="Search" icon="search" type="search" value={q} onInput={setQ} autofocus placeholder="Movies, shows, episodes…" />
          <div class="muted" style={{ fontSize: '1.05rem', margin: '0.8rem 1rem' }}>
            {busy ? 'Searching…' : res && !res.length ? 'No results' : uiMode.value === 'mobile' ? '' : 'Press A to type · Y jumps here from anywhere on this tab'}
          </div>
        </div>
        {[
          ['Movies', movies, 'poster'],
          ['Shows', shows, 'poster'],
          ['Episodes', eps, 'thumb'],
        ].map(([title, items, kind]) =>
          (items as Item[]).length ? (
            <section class={`row row-${kind}`} data-group={'s-' + title} data-scrollunit key={title as string}>
              <h2 class="row-title">{title as string}</h2>
              <div class="row-viewport" data-hscroll>
                <div class="row-track">
                  {(items as Item[]).map((it) => (
                    <Card
                      key={it.Id}
                      item={it}
                      kind={kind as 'poster' | 'thumb'}
                      fkey={'sr-' + it.Id}
                      onSelect={(x) => (x.Type === 'Episode' ? playItem(x) : openItem(x))}
                      onFocus={(x) => setBackdrop(backdropUrl(x), 0.6)}
                    />
                  ))}
                </div>
              </div>
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}
