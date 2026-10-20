import { useMemo, useRef } from 'react';

type AnyFn = (...args: any[]) => any;

/**
 * Turns an object of handlers into an object of functions whose identities never change but
 * always call the latest handler. Passing these to memoized children (DualPane, FilePanel rows)
 * lets them skip re-rendering when unrelated App state changes (queue polling, modals).
 *
 * The set of keys must be the same on every render.
 */
export function useStableHandlers<T extends Record<string, AnyFn>>(handlers: T): T {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useMemo(() => {
    const out: Record<string, AnyFn> = {};
    for (const key of Object.keys(ref.current)) {
      out[key] = (...args: any[]) => ref.current[key](...args);
    }
    return out as T;
  }, []);
}
