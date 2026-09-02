'use client';

import { useEffect, useRef, useState } from 'react';

type ReaderSurfaceAdoptionState = {
  adoptedAttemptKey: string | null;
  failure: { attemptKey: string; error: Error } | null;
};

/**
 * Runs one synchronous adoption command for each explicit reader surface
 * attempt. Callback/object identity changes are intentionally isolated behind
 * refs so provider rerenders cannot repeat the transaction.
 */
export function useReaderSurfaceAdoption(input: {
  attemptKey: string;
  enabled: boolean;
  adopt: () => void;
}): ReaderSurfaceAdoptionState {
  const adoptRef = useRef(input.adopt);
  adoptRef.current = input.adopt;
  const claimedAttemptKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<ReaderSurfaceAdoptionState>({
    adoptedAttemptKey: null,
    failure: null,
  });

  useEffect(() => {
    if (!input.enabled || claimedAttemptKeyRef.current === input.attemptKey) return;

    // Claim before provider mutation. React Strict Mode's second effect setup
    // and rerenders caused by the mutation both observe the claimed key.
    claimedAttemptKeyRef.current = input.attemptKey;
    try {
      adoptRef.current();
      setState({ adoptedAttemptKey: input.attemptKey, failure: null });
    } catch (error) {
      setState({
        adoptedAttemptKey: null,
        failure: {
          attemptKey: input.attemptKey,
          error: error instanceof Error
            ? error
            : new Error('Failed to initialize the reader session.'),
        },
      });
    }
  }, [input.attemptKey, input.enabled]);

  return state;
}
