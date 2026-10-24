import { Item, setFavorite, setPlayed, removeFromResume, seriesNextUp, api, auth } from './jellyfin';
import { push } from './router';
import { openPicker, showToast, Opt } from '../components/Dialog';
import { log } from './log';

/** Data attached to focusable cards so global shortcuts (X / Menu) can act on them. */
const registry = new Map<string, Item>();
export function registerItem(it: Item) {
  registry.set(it.Id, it);
}
export function itemFromEl(el: Element | null): Item | undefined {
  const id = (el as HTMLElement | null)?.closest<HTMLElement>('[data-item]')?.dataset.item;
  return id ? registry.get(id) : undefined;
}

export function openItem(it: Item) {
  if (it.Type === 'Season' && it.SeriesId) push({ name: 'item', id: it.SeriesId, seasonId: it.Id });
  else push({ name: 'item', id: it.Id });
}

export function playItem(it: Item, fromStart = false) {
  if (it.Type === 'Series' || it.Type === 'Season' || it.Type === 'BoxSet') {
    openItem(it);
    return;
  }
  push({ name: 'player', id: it.Id, fromStart });
}

/** Play right away: movie/episode resumes (or starts); a series plays its Next Up episode, else S1E1. */
export async function playNow(it: Item) {
  if (it.Type !== 'Series') return playItem(it);
  try {
    const nu = await seriesNextUp(it.Id);
    let ep = nu.Items[0];
    if (!ep) {
      const r = await api<{ Items: Item[] }>(`/Shows/${it.Id}/Episodes?userId=${auth.value!.userId}&Limit=1`);
      ep = r.Items[0];
    }
    if (ep) return push({ name: 'player', id: ep.Id });
  } catch (e) {
    log('playNow failed', String(e));
  }
  openItem(it);
}

export const isPlayTile = (it: Item) => it.Type === 'Episode' || (it.UserData?.PlaybackPositionTicks ?? 0) > 0;

export function contextMenu(it: Item, onChange?: (it: Item) => void) {
  const played = !!it.UserData?.Played;
  const fav = !!it.UserData?.IsFavorite;
  const resumable = (it.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const container = it.Type === 'Series' || it.Type === 'Season' || it.Type === 'BoxSet';
  // Order: primary action first (it gets focus), then navigation, then state changes.
  const opts: Opt[] = [
    ...(!container ? [{ label: resumable ? 'Resume' : 'Play', value: 'play', icon: 'play' as const } as Opt] : [{ label: 'Play', value: 'playnow', icon: 'play' as const } as Opt]),
    ...(resumable ? [{ label: 'Play from beginning', value: 'restart', icon: 'restart' as const } as Opt] : []),
    { label: it.Type === 'Episode' ? 'Go to episode' : 'Open details', value: 'info', icon: 'info' as const },
    ...(it.Type === 'Episode' && it.SeriesId ? [{ label: 'Go to series', value: 'series', icon: 'shows' as const } as Opt] : []),
    { label: played ? 'Mark as unwatched' : 'Mark as watched', value: 'played', icon: played ? ('undo' as const) : ('watched' as const) },
    ...(resumable && !container ? [{ label: 'Remove from Continue Watching', value: 'unresume', icon: 'close' as const } as Opt] : []),
    { label: fav ? 'Remove from favorites' : 'Add to favorites', value: 'fav', icon: 'heart' as const },
  ];
  openPicker([
    {
      title: it.Type === 'Episode' ? `${it.SeriesName} · ${it.Name}` : it.Name,
      options: opts,
      onPick: async (v) => {
        try {
          if (v === 'info') openItem(it);
          else if (v === 'play') playItem(it);
          else if (v === 'playnow') playNow(it);
          else if (v === 'restart') playItem(it, true);
          else if (v === 'series') push({ name: 'item', id: it.SeriesId!, seasonId: it.SeasonId });
          else if (v === 'played') {
            const ud = await setPlayed(it.Id, !played);
            it.UserData = { ...it.UserData, ...ud };
            showToast(!played ? 'Marked as watched' : 'Marked as unwatched');
            onChange?.(it);
          } else if (v === 'unresume') {
            const ud = await removeFromResume(it.Id);
            it.UserData = { ...it.UserData, ...ud };
            showToast('Removed from Continue Watching');
            onChange?.(it);
          } else if (v === 'fav') {
            const ud = await setFavorite(it.Id, !fav);
            it.UserData = { ...it.UserData, ...ud };
            showToast(!fav ? 'Added to favorites' : 'Removed from favorites');
            onChange?.(it);
          }
        } catch (e) {
          log('context action failed', v, String(e));
          showToast('Action failed');
        }
      },
    },
  ]);
}
