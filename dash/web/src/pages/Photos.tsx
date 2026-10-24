import { photos, photoUrl, type Photo, unconfigured } from '../lib/data';
import { openPhoto } from '../App';

export function Photos() {
  const p = photos.value;
  if (!p) return <div class="page-pad muted">{unconfigured.value['/api/photos'] ?? 'Loading…'}</div>;
  // One row per kind (all "On this day" years merged) so the page fits a single 1080p screen without scrolling.
  const memItems: (Photo & { memo?: string })[] = p.memories.flatMap((m) => m.assets.map((a) => ({ ...a, memo: m.title })));
  const rows: { title: string; items: (Photo & { memo?: string })[] }[] = [
    { title: 'On this day', items: memItems },
    { title: 'Favorites', items: p.favorites },
    { title: 'Rediscover', items: p.random },
  ].filter((r) => r.items.length).slice(0, 3);
  return (
    <div class="page-pad photos-page" style={{ '--ph-w': ['40rem', '40rem', '30rem', '19rem'][rows.length] ?? '19rem' }}>
      <h1 class="page-title">Photos</h1>
      {rows.map((r, ri) => (
        <section class="row">
          <h2 class="row-title">{r.title} <span class="pill">{r.items.length}</span></h2>
          <div class="row-viewport" data-hscroll data-group={'ph-' + ri}>
            <div class="row-track">
              {r.items.map((ph, i) => (
                <button class="card thumb focusable" data-autofocus={(ri === 0 && i === 0) || undefined} onClick={() => openPhoto(r.items, i)}>
                  <div class="card-art"><img src={photoUrl(ph.id, 'thumbnail')} loading="lazy" /></div>
                  {(ph.memo || ph.place || ph.taken) && <div class="card-cap dim">{[ph.memo, ph.place || (ph.taken && new Date(ph.taken).getFullYear())].filter(Boolean).join(' · ')}</div>}
                </button>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
