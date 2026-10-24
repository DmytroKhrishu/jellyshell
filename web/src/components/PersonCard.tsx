// Round cast/crew card (photo, name, role) + a credit poster card. Shared by the item detail page,
// the person page and the TMDB detail page. Selecting a person opens `{ name: 'person' }`.
import { Img } from './Img';
import { Icon } from './icons';
import { imageUrl } from '../lib/jellyfin';
import { tmdbImg } from '../lib/seerr';
import { push } from '../lib/router';
import { registerItem } from '../lib/actions';
import type { Credit } from '../lib/person';
import '../styles/person.css';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s[0])
    .join('');

export interface PersonRef {
  name: string;
  role?: string;
  /** Jellyfin person id + image tag (library cast). */
  jfId?: string;
  imageTag?: string;
  /** TMDB person id + profile path (Seerr cast). */
  tmdbId?: number;
  profilePath?: string | null;
}

export function openPerson(p: { jfId?: string; tmdbId?: number }) {
  if (p.jfId) push({ name: 'person', jfId: p.jfId, ...(p.tmdbId ? { tmdbId: p.tmdbId } : {}) });
  else if (p.tmdbId) push({ name: 'person', tmdbId: p.tmdbId });
}

export function PersonCard({ p, fkey }: { p: PersonRef; fkey: string }) {
  const src = p.jfId && p.imageTag ? imageUrl(p.jfId, 'Primary', { tag: p.imageTag, maxWidth: 240 }) : tmdbImg(p.profilePath, 'w342');
  const can = !!(p.jfId || p.tmdbId);
  return (
    <div
      class={'person focusable card' + (can ? ' person-link' : '')}
      tabIndex={-1}
      data-fkey={fkey}
      onClick={() => can && openPerson(p)}
      role={can ? 'link' : undefined}
      aria-label={p.role ? `${p.name}, ${p.role}` : p.name}
    >
      <div class="face">
        <Img src={src} alt={initials(p.name)} />
      </div>
      <div class="nm">{p.name}</div>
      {p.role && <div class="rl">{p.role}</div>}
    </div>
  );
}

/** Poster card for a filmography entry; marked when the title is in the Jellyfin library. */
export function CreditCard({ c, fkey, onSelect }: { c: Credit; fkey: string; onSelect: (c: Credit) => void }) {
  if (c.lib) registerItem(c.lib); // X / Menu / hold A act on the library item like any other card
  return (
    <div class="card poster focusable pp-credit" tabIndex={-1} data-fkey={fkey} data-item={c.lib?.Id} onClick={() => onSelect(c)}>
      <div class="card-art">
        <Img src={c.poster} alt={c.title} />
        {c.lib && (
          <span class="pp-inlib" title="In your library">
            <Icon name="library" stroke={2.6} />
          </span>
        )}
      </div>
      <div class="card-text">
        <div class="card-title">{c.title}</div>
        <div class="card-sub">{[c.year, c.role].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}
