import type { TtsCredentialBrokerErrorCode } from '@openreader/tts/credential-broker';

export type BrokerClientErrorCode = TtsCredentialBrokerErrorCode
  | 'BROKER_CONFIG_INVALID'
  | 'BROKER_NETWORK_ERROR'
  | 'BROKER_REQUEST_TIMEOUT'
  | 'BROKER_RESPONSE_INVALID';

export class TtsCredentialBrokerClientError extends Error {
  readonly code: BrokerClientErrorCode;
  readonly retryable: boolean;

  constructor(code: BrokerClientErrorCode, retryable: boolean) {
    super(`TTS credential broker request failed: ${code}`);
    this.name = 'TtsCredentialBrokerClientError';
    this.code = code;
    this.retryable = retryable;
  }
}
