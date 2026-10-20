import { useCallback, useState } from 'react';

// Filter state that survives a page refresh (2026-10-20).
//
// Entity pickers and date windows used to reset on every reload, so a
// refresh silently threw away whatever the user had chosen and dropped them
// back on the default view. This keeps the choice in localStorage, per key.
//
// Only view preferences belong here — never figures, never anything the
// books depend on. localStorage can be empty, stale, or throw outright
// (private windows, blocked site data), so every access is guarded and the
// hook falls back to the supplied default rather than failing to render.
export function useStickyState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable — the choice still applies for this session.
      }
    },
    [key],
  );

  return [value, set];
}
