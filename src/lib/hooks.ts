import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * A ref that always holds the latest `value`. Lets long-lived callbacks
 * (event listeners, timers, CodeMirror handlers) read current props and state
 * without being re-created on every render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/**
 * A stable debounced wrapper around `fn`. It always calls the latest `fn`,
 * and pending calls are cancelled on unmount.
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  const fnRef = useLatest(fn);

  const debounced = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wrapper = (...args: A) => {
      clearTimeout(timer);
      timer = setTimeout(() => fnRef.current(...args), waitMs);
    };
    wrapper.cancel = () => clearTimeout(timer);
    return wrapper;
  }, [fnRef, waitMs]);

  useEffect(() => debounced.cancel, [debounced]);
  return debounced;
}

/** Current time, refreshed every `intervalMs`. Use it for "5 min ago" labels. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
