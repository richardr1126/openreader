'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

/**
 * Owns the explicit attempt counter shared by renderer retry and aggregate
 * bootstrap restart. Restart closes the caller's ready gate before advancing
 * the attempt and keeps adoption disabled until the refetch has settled.
 */
export function useReaderSurfaceAttempt<TOptions = never>(input: {
  restartBootstrap: (options?: TOptions) => Promise<unknown>;
  onRestart: () => void;
}) {
  const restartBootstrapRef = useRef(input.restartBootstrap);
  restartBootstrapRef.current = input.restartBootstrap;
  const onRestartRef = useRef(input.onRestart);
  onRestartRef.current = input.onRestart;
  const [attempt, setAttempt] = useState(0);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartOptions, setRestartOptions] = useState<TOptions | null>(null);

  const advance = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const restart = useCallback(async (options?: TOptions) => {
    setIsRestarting(true);
    setRestartOptions(options ?? null);
    onRestartRef.current();
    advance();
    try {
      await restartBootstrapRef.current(options);
    } finally {
      setIsRestarting(false);
      setRestartOptions(null);
    }
  }, [advance]);

  return { attempt, isRestarting, restartOptions, advance, restart };
}
