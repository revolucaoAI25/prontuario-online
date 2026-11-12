import { useCallback, useEffect, useRef, useState } from 'react';

// Loads data with `loader` whenever `deps` change; `reload()` refetches.
export function useLoad(loader, deps) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader();
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Runs fn every ms while the page is visible; a hidden tab (the system left
// open in the background) skips the ticks, and catches up once when it is
// shown again. Live updates (realtime) keep flowing either way.
export function useInterval(fn, ms) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!ms) return undefined;
    let missed = false;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { missed = true; return; }
      saved.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && missed) { missed = false; saved.current(); }
    };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [ms]);
}

// fn, called at most once per burst: calls within ms of each other collapse
// into one (a WhatsApp message brings sent/delivered/read updates in a row).
export function useCoalesced(fn, ms = 600) {
  const saved = useRef(fn);
  saved.current = fn;
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saved.current(), ms);
  }, [ms]);
}

