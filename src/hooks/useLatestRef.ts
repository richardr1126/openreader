'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keeps the latest value available to lifecycle effects without making that
 * value part of the lifecycle's trigger contract.
 *
 * Uses useLayoutEffect so ref.current is updated synchronously after commit
 * (before paint), eliminating the window where a sibling effect or cleanup
 * could read a stale value.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);

  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}
