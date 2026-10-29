import type { ComponentChildren } from 'preact';
import { Icon } from './icons';
import { Img } from './Img';
import { registerItem } from '../lib/actions';
import { Item, posterUrl, thumbUrl, progressPct, episodeLabel } from '../lib/jellyfin';

export type CardKind = 'poster' | 'thumb';

interface CardProps {
  item: Item;
  kind: CardKind;
  fkey: string;
  onSelect: (it: Item, el: HTMLElement) => void;
  onFocus?: (it: Item) => void;
  autofocus?: boolean;
  title?: string;
  subtitle?: string;
  /** Extra text under the subtitle, inside the card so it scales with focus (episode overview). */
  extra?: ComponentChildren;
}

export function Card({ item, kind, fkey, onSelect, onFocus, autofocus, title: titleOv, subtitle, extra }: CardProps) {
  registerItem(item);
  const pct = progressPct(item);
  const played = item.UserData?.Played;
  const unplayed = item.UserData?.UnplayedItemCount;
  const src = kind === 'poster' ? posterUrl(item, 360) : thumbUrl(item, 560);
  const title = titleOv ?? (item.Type === 'Episode' ? item.SeriesName ?? item.Name : item.Name);
  const sub =
    subtitle ??
    (item.Type === 'Episode'
      ? `${episodeLabel(item)} · ${item.Name}`
      : item.ProductionYear
        ? String(item.ProductionYear)
        : '');
  return (
    <div
      class={`card ${kind} focusable`}
      tabIndex={-1}
      data-fkey={fkey}
      data-item={item.Id}
      data-autofocus={autofocus || undefined}
      onClick={(e) => onSelect(item, e.currentTarget as HTMLElement)}
      onFocus={() => onFocus?.(item)}
    >
      <div class="card-art">
        <Img src={src} alt={title} />
        {pct > 0 && pct < 100 && !played && (
          <div class="progress">
            <i style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        )}
        {played && <div class="badge-check" aria-label="watched"><Icon name="check" stroke={3} /></div>}
        {!played && !!unplayed && item.Type === 'Series' && <div class="badge-count">{unplayed}</div>}
      </div>
      <div class="card-text">
        <div class="card-title">{title}</div>
        {sub && <div class="card-sub">{sub}</div>}
        {extra}
      </div>
    </div>
  );
}

interface RowProps {
  title: string;
  id: string;
  children: ComponentChildren;
  kind?: CardKind;
  /** Left/Right stop (bump) at the row's ends instead of jumping diagonally into a longer row above/below. */
  lockEnds?: boolean;
}
export function Row({ title, id, children, kind = 'poster', lockEnds }: RowProps) {
  return (
    <section class={`row row-${kind}`} data-group={id} data-scrollunit data-block={lockEnds ? 'left right' : undefined}>
      <h2 class="row-title">{title}</h2>
      <div class="row-viewport" data-hscroll>
        <div class="row-track">{children}</div>
      </div>
    </section>
  );
}

export function SkeletonRow({ kind = 'poster', count = 8 }: { kind?: CardKind; count?: number }) {
  return (
    <section class={`row row-${kind} skeleton-row`}>
      <h2 class="row-title"><span class="sk sk-text" /></h2>
      <div class="row-viewport">
        <div class="row-track">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} class={`card ${kind}`}>
              <div class="card-art sk" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
