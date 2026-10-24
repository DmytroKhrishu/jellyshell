import { useEffect, useState, useRef } from 'preact/hooks';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Tiny data hook: runs `fn` when deps change; keeps previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const live = useRef(0);
  useEffect(() => {
    const id = ++live.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => id === live.current && setState({ data, loading: false }),
      (error) => id === live.current && setState({ error, loading: false }),
    );
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) } as AsyncState<T>;
}
