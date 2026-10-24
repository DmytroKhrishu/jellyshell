import { useRef, useState } from 'preact/hooks';
import { Icon } from '../components/icons';
import { Card } from '../components/Card';
import { setBackdrop } from '../components/Backdrop';
import { Item, SortKey, WatchedFilter, backdropUrl, library } from '../lib/jellyfin';
import { useAsync } from '../lib/useAsync';
import { useInitialFocus } from '../lib/useInitialFocus';
import { openItem } from '../lib/actions';
import { openPicker } from '../components/Dialog';
import { focusFirst } from '../lib/focus';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'SortName', label: 'A–Z' },
  { key: 'DateCreated', label: 'Date added' },
  { key: 'ProductionYear', label: 'Year' },
  { key: 'CommunityRating', label: 'Rating' },
];
const FILTERS: { key: WatchedFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unwatched', label: 'Unwatched' },
  { key: 'watched', label: 'Watched' },
];

export function Library({ type, title, active, refreshKey }: { type: 'Movie' | 'Series'; title: string; active: boolean; refreshKey: number }) {
  const prefKey = `jellyshell.lib.${type}`;
  const saved = JSON.parse(localStorage.getItem(prefKey) || '{}');
  const [sort, setSort] = useState<SortKey>(saved.sort ?? 'SortName');
  const [watched, setWatched] = useState<WatchedFilter>(saved.watched ?? 'all');
  const { data, loading, error } = useAsync(() => library(type, sort, watched), [type, sort, watched, refreshKey]);
  const ref = useRef<HTMLDivElement>(null);
  useInitialFocus(ref, active, !!data);

  const persist = (s: SortKey, w: WatchedFilter) => localStorage.setItem(prefKey, JSON.stringify({ sort: s, watched: w }));
  const sortLabel = SORTS.find((s) => s.key === sort)!.label;
  const filterLabel = FILTERS.find((f) => f.key === watched)!.label;

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="10rem" data-marginbottom="6rem" data-group={'lib-' + type}>
      <div class="vtrack page-pad">
        <div class="lib-head" data-scrolltop data-group={'libhead-' + type}>
          <h1>{title}</h1>
          <div
            class="pill focusable"
            tabIndex={-1}
            onClick={() =>
              openPicker([
                {
                  title: 'Sort by',
                  options: SORTS.map((s) => ({ label: s.label, value: s.key, selected: s.key === sort })),
                  onPick: (v) => {
                    setSort(v as SortKey);
                    persist(v as SortKey, watched);
                  },
                },
              ])
            }
          >
            Sort: {sortLabel} <Icon name="chevDown" class="chev" />
          </div>
          <div
            class="pill focusable"
            tabIndex={-1}
            onClick={() =>
              openPicker([
                {
                  title: 'Show',
                  options: FILTERS.map((f) => ({ label: f.label, value: f.key, selected: f.key === watched })),
                  onPick: (v) => {
                    setWatched(v as WatchedFilter);
                    persist(sort, v as WatchedFilter);
                  },
                },
              ])
            }
          >
            {filterLabel} <Icon name="chevDown" class="chev" />
          </div>
          {(sort !== 'SortName' || watched !== 'all') && (
            <div
              class="pill reset focusable"
              tabIndex={-1}
              data-fkey={'reset-' + type}
              onClick={(e) => {
                setSort('SortName');
                setWatched('all');
                persist('SortName', 'all');
                // the Reset pill disappears: keep focus in the header on the Sort pill
                const head = (e.currentTarget as HTMLElement).parentElement;
                requestAnimationFrame(() => focusFirst(head));
              }}
            >
              Reset
            </div>
          )}
          <span class="count">{data ? `${data.TotalRecordCount} ${type === 'Movie' ? 'movies' : 'shows'}` : ''}</span>
        </div>
        {error && <div class="err">Couldn't load library: {String(error.message)}</div>}
        {!data && loading && (
          <div class="grid">
            {Array.from({ length: 21 }, (_, i) => (
              <div key={i} class="card poster">
                <div class="card-art sk" />
              </div>
            ))}
          </div>
        )}
        {data && data.Items.length === 0 && <div class="dim" style={{ fontSize: '1.4rem' }}>Nothing here with this filter.</div>}
        {data && (
          <div class="grid" data-group={'grid-' + type} key={sort + watched}>
            {data.Items.map((it: Item, i) => (
              <Card
                key={it.Id}
                item={it}
                kind="poster"
                fkey={`g-${type}-${it.Id}`}
                autofocus={i === 0}
                onSelect={(x) => openItem(x)}
                onFocus={(x) => setBackdrop(backdropUrl(x), 0.6)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function refocusGrid(root: HTMLElement | null) {
  focusFirst(root);
}
