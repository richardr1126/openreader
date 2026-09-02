import {
  parseTtsCredentialBrokerErrorResponse,
  parseTtsCredentialBrokerResponse,
  type TtsCredentialBrokerErrorCode,
  type TtsCredentialBrokerResponse,
} from '@openreader/tts/credential-broker';
import { getTtsCredentialBrokerConfig } from '../infrastructure/credential-broker-config';
import { TtsCredentialBrokerClientError } from './tts-credential-broker-error';

export { TtsCredentialBrokerClientError } from './tts-credential-broker-error';

const DEFAULT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 100;

function retryableBrokerCode(code: TtsCredentialBrokerErrorCode): boolean {
  return code === 'BROKER_UNAVAILABLE';
}

async function requestOnce(input: {
  providerRef: string;
  url: URL;
  token: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<TtsCredentialBrokerResponse> {
  if (input.signal?.aborted) throw input.signal.reason;
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('broker request timeout')), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerRef: input.providerRef }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = parseTtsCredentialBrokerErrorResponse(body);
      const code = parsedError?.error ?? 'BROKER_RESPONSE_INVALID';
      throw new TtsCredentialBrokerClientError(
        code,
        code === 'BROKER_RESPONSE_INVALID' ? response.status >= 500 : retryableBrokerCode(code),
      );
    }
    const parsed = parseTtsCredentialBrokerResponse(body);
    if (!parsed) throw new TtsCredentialBrokerClientError('BROKER_RESPONSE_INVALID', false);
    return parsed;
  } catch (error) {
    if (error instanceof TtsCredentialBrokerClientError) throw error;
    if (input.signal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new TtsCredentialBrokerClientError('BROKER_REQUEST_TIMEOUT', true);
    }
    throw new TtsCredentialBrokerClientError('BROKER_NETWORK_ERROR', true);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

async function waitForRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function resolveTtsCredentialsFromBroker(
  providerRef: string,
  options: { signal?: AbortSignal; attempts?: number } = {},
): Promise<TtsCredentialBrokerResponse> {
  const config = getTtsCredentialBrokerConfig();
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce({ providerRef, ...config, signal: options.signal });
    } catch (error) {
      lastError = error;
      if (
        options.signal?.aborted
        || !(error instanceof TtsCredentialBrokerClientError)
        || !error.retryable
        || attempt >= attempts
      ) throw error;
      await waitForRetry(options.signal);
    }
  }
  throw lastError;
}
