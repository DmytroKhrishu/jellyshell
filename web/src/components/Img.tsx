import { useEffect, useRef, useState } from 'preact/hooks';

let io: IntersectionObserver | null = null;
const cbs = new WeakMap<Element, () => void>();
function observer() {
  if (!io)
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            cbs.get(e.target)?.();
            io!.unobserve(e.target);
          }
      },
      { rootMargin: '60% 60% 60% 60%' },
    );
  return io;
}

/** Lazy image that shimmers until loaded, then fades in. */
export function Img({ src, class: cls = '', alt = '', eager = false }: { src: string | null; class?: string; alt?: string; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(eager);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (eager || !ref.current) return;
    const el = ref.current;
    cbs.set(el, () => setShow(true));
    observer().observe(el);
    return () => observer().unobserve(el);
  }, [src]);
  return (
    <div ref={ref} class={`img ${cls} ${loaded ? 'loaded' : 'loading'} ${!src || failed ? 'noimg' : ''}`}>
      {src && show && !failed && <img src={src} alt={alt} decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
      {(!src || failed) && <span class="img-fallback">{alt}</span>}
    </div>
  );
}
