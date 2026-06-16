/**
 * Shared query-state derivation for the data-storage refactor.
 *
 * Domain hooks return the native React Query result plus a consistent set of
 * derived booleans so every consumer renders the same loading/error/refresh
 * contract:
 *
 *   initialLoading -> no usable data exists yet (blocking skeleton)
 *   refreshing     -> usable data exists while refetching (non-blocking)
 *   error          -> query failed AND no usable data exists (error + retry)
 *
 * A background refresh failure (data still present) is intentionally NOT an
 * `error`; it is surfaced via `backgroundError` as a non-blocking warning.
 */

export interface QueryStateInput {
  /** Whether the query has produced usable data. */
  hasData: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
}

export interface DerivedQueryState {
  initialLoading: boolean;
  refreshing: boolean;
  /** Hard error: failed with no usable data to fall back on. */
  error: unknown;
  /** Soft error: a refresh failed but stale data is still shown. */
  backgroundError: unknown;
}

export function deriveQueryState({ hasData, isFetching, isError, error }: QueryStateInput): DerivedQueryState {
  return {
    initialLoading: !hasData && isFetching && !isError,
    refreshing: hasData && isFetching,
    error: isError && !hasData ? error : null,
    backgroundError: isError && hasData ? error : null,
  };
}

/** Combine several required queries into one view-level query state. */
export function combineQueryStates(states: readonly DerivedQueryState[]): DerivedQueryState {
  return {
    initialLoading: states.some((state) => state.initialLoading),
    refreshing: states.some((state) => state.refreshing),
    error: states.find((state) => state.error)?.error ?? null,
    backgroundError: states.find((state) => state.backgroundError)?.backgroundError ?? null,
  };
}
