/** Ends a run whose provider failed several segments in a row. It is not retried. */
export class TtsProviderFailedError extends Error {
  readonly retryable = false;

  constructor(readonly code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED', cause: string) {
    super(code === 'PROVIDER_UNAVAILABLE'
      ? `The speech provider could not be reached: ${cause}`
      : `The speech provider rejected the request: ${cause}`);
    this.name = 'TtsProviderFailedError';
  }
}
