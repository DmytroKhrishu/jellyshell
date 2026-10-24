// HDR -> SDR picture controls. With HDR Off, Jellyfin tone-maps HDR10/DV/HLG on the server (QSV procamp + tonemap_vaapi);
// brightness/contrast are Jellyfin's VppTonemapping* values (server-wide, admin-only) via web-poc/picture_proxy.py.
// They affect NEW transcodes only, so the player restarts its stream at the current position after a change.
import { signal } from '@preact/signals';
import { auth } from './jellyfin';
import { log } from './log';
import { noPageServer } from './uisource';

export interface Picture {
  brightness: number;
  contrast: number;
  canEdit: boolean;
}

export const picture = signal<Picture | null>(null);

/** Measured mean luma on a 4K DV/HDR10 film: 40 / 56 / 77 / 102 for b = 0 / 16 / 32 / 48 (SDR content sits ~80-110). */
export const BRIGHTNESS: [number, string][] = [
  [8, 'Dim'],
  [16, 'Standard'],
  [28, 'Bright'],
  [40, 'Brighter'],
  [52, 'Brightest'],
];
export const CONTRAST: [number, string][] = [
  [1, 'Standard'],
  [1.15, 'Punchy'],
  [1.3, 'Vivid'],
];

const near = (list: [number, string][], v: number) => list.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a));
export const brightnessLabel = (v: number) => near(BRIGHTNESS, v)[1];
export const contrastLabel = (v: number) => near(CONTRAST, v)[1];
export const nextStep = (list: [number, string][], v: number) => list[(list.indexOf(near(list, v)) + 1) % list.length][0];

async function call(body?: Partial<Picture>): Promise<Picture> {
  const a = auth.value;
  const res = await fetch('api/picture', {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: { 'X-Jellyfin-Token': a?.token ?? '', 'X-Jellyfin-User': a?.userId ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || String(res.status));
  return data as Picture;
}

export async function loadPicture() {
  if (noPageServer()) return picture.value; // bundled: no api/picture (row + player button stay hidden)
  try {
    picture.value = await call();
  } catch (e: any) {
    log('picture load failed', String(e?.message ?? e));
  }
  return picture.value;
}

export async function setPicture(p: { brightness?: number; contrast?: number }) {
  const prev = picture.value;
  if (prev) picture.value = { ...prev, ...p }; // optimistic: the label updates at once
  try {
    picture.value = await call(p);
    log('picture set', picture.value);
    return true;
  } catch (e: any) {
    picture.value = prev;
    log('picture set failed', String(e?.message ?? e));
    return false;
  }
}
