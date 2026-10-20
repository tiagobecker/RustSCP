import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns a function whose identity never changes but always calls the latest `fn`.
 * Lets App pass handlers down to memoized panels/rows without re-creating them on every render,
 * while the handler still sees current state.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Assign during render so handlers invoked from effects in the same commit see the new closure,
  // and again in a layout effect for concurrent renders that were thrown away.
  ref.current = fn;
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
