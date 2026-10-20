import { useCallback, useRef, useState } from 'react';

type Updater<T> = T | ((prev: T) => T);

/**
 * useState plus a ref that is updated synchronously by the setter.
 *
 * The workspace often needs "the value right now" inside async flows (a directory listing that
 * resolves after the user switched tabs, closing a tab and then disconnecting in the same event).
 * Reading the ref avoids stale closures and avoids computing values inside setState updaters,
 * which React may run later (or twice in StrictMode).
 */
export function useRefState<T>(initial: T | (() => T)) {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(state);
  const set = useCallback((next: Updater<T>) => {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next;
    if (Object.is(value, ref.current)) return;
    ref.current = value;
    setState(value);
  }, []);
  return [state, set, ref] as const;
}
