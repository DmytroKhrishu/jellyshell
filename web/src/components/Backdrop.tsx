import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Global page backdrop. `dim` 0..1 darkens it (rows/grid) vs hero (bright). */
export const backdrop = signal<{ url: string | null; dim: number }>({ url: null, dim: 0.35 });

let pending: number | undefined;
/** Debounced: fast focus travel doesn't thrash image loads. */
export function setBackdrop(url: string | null, dim = 0.35, delay = 150) {
  window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    if (backdrop.value.url !== url || backdrop.value.dim !== dim) backdrop.value = { url, dim };
  }, delay);
}

interface Layer {
  url: string | null;
  id: number;
}

export function Backdrop() {
  const { url, dim } = backdrop.value;
  const [layers, setLayers] = useState<Layer[]>([{ url: null, id: 0 }]);
  const seq = useRef(1);
  useEffect(() => {
    if (url === layers[layers.length - 1]?.url) return;
    let cancelled = false;
    const commit = () => {
      if (!cancelled) setLayers((ls) => [...ls.slice(-1), { url, id: seq.current++ }]);
    };
    if (!url) {
      commit();
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().then(commit, commit);
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div class="backdrop" aria-hidden="true">
      {layers.map((l, i) =>
        l.url ? (
          <div key={l.id} class={'bd-layer' + (i === layers.length - 1 ? ' in' : ' out')}>
            <img src={l.url} alt="" />
          </div>
        ) : (
          <div key={l.id} class={'bd-layer' + (i === layers.length - 1 ? ' in' : ' out')} />
        ),
      )}
      <div class="bd-dim" style={{ opacity: dim }} />
      <div class="bd-grad" />
    </div>
  );
}
