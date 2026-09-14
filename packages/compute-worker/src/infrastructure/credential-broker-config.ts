import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { TtsCredentialBrokerClientError } from '../jobs/tts-credential-broker-error';

const DEFAULT_TIMEOUT_MS = 5_000;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface TtsCredentialBrokerConfig {
  url: URL;
  token: string;
  timeoutMs: number;
}

function permitsPlainHttp(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '[::1]'
    || (hostname.startsWith('127.') && isIP(hostname) === 4);
}

export function getTtsCredentialBrokerConfig(): TtsCredentialBrokerConfig {
  const rawUrl = process.env.COMPUTE_CREDENTIAL_BROKER_URL?.trim();
  const token = process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN?.trim();
  if (!rawUrl || !token) throw new TtsCredentialBrokerClientError('BROKER_CONFIG_INVALID', false);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TtsCredentialBrokerClientError('BROKER_CONFIG_INVALID', false);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || (url.protocol === 'http:' && !permitsPlainHttp(url))
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/api/internal/compute/tts-credentials'
  ) {
    throw new TtsCredentialBrokerClientError('BROKER_CONFIG_INVALID', false);
  }
  return {
    url,
    token,
    timeoutMs: readPositiveInt(process.env.COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function getComputeLimitBrokerConfig(): TtsCredentialBrokerConfig {
  const config = getTtsCredentialBrokerConfig();
  const url = new URL(config.url);
  url.pathname = '/api/internal/compute/limits/consume';
  return { ...config, url };
}

export function getComputeLimitCompletionBrokerConfig(): TtsCredentialBrokerConfig {
  const config = getTtsCredentialBrokerConfig();
  const url = new URL(config.url);
  url.pathname = '/api/internal/compute/limits/complete';
  return { ...config, url };
}

export function getEmailExecutionBrokerConfig(): TtsCredentialBrokerConfig {
  const config = getTtsCredentialBrokerConfig();
  const url = new URL(config.url);
  url.pathname = '/api/internal/compute/email-execution';
  return { ...config, url };
}

export function requireTtsSegmentTextHashSecret(): string {
  const playbackSecret = process.env.TTS_PLAYBACK_TOKEN_SECRET?.trim();
  if (!playbackSecret) throw new Error('TTS_PLAYBACK_TOKEN_SECRET is required for playback segment metadata');
  return createHmac('sha256', playbackSecret)
    .update('openreader:tts-segment-text:v1')
    .digest('base64url');
}
