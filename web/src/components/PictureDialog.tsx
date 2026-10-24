// Brightness / Contrast picker for HDR -> SDR tone mapping (Settings and the player's Picture button).
import { openPicker, dialog } from './Dialog';
import { picture, setPicture, BRIGHTNESS, CONTRAST, brightnessLabel, contrastLabel } from '../lib/picture';

/** onChanged runs after the server accepted a new value (the player restarts its stream there). */
export function openPictureDialog(onChanged?: () => void) {
  const p = picture.value;
  if (!p) return;
  const pick = async (v: { brightness?: number; contrast?: number }) => {
    const req = setPicture(v); // optimistic: picture.value already holds the new value
    if (dialog.value) openPictureDialog(onChanged); // rebuild so the tick follows the new value
    const ok = await req;
    if (!ok && dialog.value) openPictureDialog(onChanged); // reverted
    if (ok) onChanged?.();
  };
  openPicker(
    [
      {
        title: 'Brightness',
        icon: 'brightness',
        note: 'HDR films converted to SDR on the server. Applies to all devices.',
        options: BRIGHTNESS.map(([v, l]) => ({ label: l, value: String(v), selected: l === brightnessLabel(p.brightness) })),
        onPick: (v) => pick({ brightness: +v }),
      },
      {
        title: 'Contrast',
        icon: 'contrast',
        options: CONTRAST.map(([v, l]) => ({ label: l, value: String(v), selected: l === contrastLabel(p.contrast) })),
        onPick: (v) => pick({ contrast: +v }),
      },
    ],
    false,
  );
}
