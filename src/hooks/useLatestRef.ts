'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps the latest value available to lifecycle effects without making that
 * value part of the lifecycle's trigger contract.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}
