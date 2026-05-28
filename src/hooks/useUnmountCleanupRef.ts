import { useEffect, useRef } from 'react';

/**
 * Runs cleanup only on unmount, while always invoking the latest cleanup function.
 */
export function useUnmountCleanupRef(cleanup: () => void) {
  const cleanupRef = useRef(cleanup);

  useEffect(() => {
    cleanupRef.current = cleanup;
  }, [cleanup]);

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);
}

