'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';

type ReaderSurfaceAdoptionState = {
  adoptedAttemptKey: string | null;
  failure: { attemptKey: string; error: Error } | null;
};

/**
 * Runs one synchronous adoption command for each explicit reader surface
 * attempt. The adopt callback is an effect event, so its identity changes
 * cannot repeat the transaction when the provider rerenders.
 */
export function useReaderSurfaceAdoption(input: {
  attemptKey: string;
  enabled: boolean;
  adopt: () => void;
}): ReaderSurfaceAdoptionState {
  const adopt = useEffectEvent(input.adopt);
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
      adopt();
      // The state records the outcome of the external command this effect ran.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
