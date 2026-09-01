import { isBuiltInTtsProviderId, type TtsProviderId } from './provider-catalog';

const SHARED_PROVIDER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const TTS_CREDENTIAL_BROKER_ERROR_CODES = [
  'BROKER_UNAUTHORIZED',
  'PROVIDER_REF_INVALID',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_DECRYPT_FAILED',
  'BROKER_UNAVAILABLE',
] as const;

export type TtsCredentialBrokerErrorCode = (typeof TTS_CREDENTIAL_BROKER_ERROR_CODES)[number];

export interface TtsCredentialBrokerRequest {
  providerRef: string;
}

export interface TtsCredentialBrokerResponse {
  providerRef: string;
  providerType: TtsProviderId;
  apiKey: string;
  baseUrl: string | null;
  defaultModel: string | null;
  defaultInstructions: string | null;
}

export interface TtsCredentialBrokerErrorResponse {
  error: TtsCredentialBrokerErrorCode;
}

function normalizedOptionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeTtsCredentialProviderRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (isBuiltInTtsProviderId(normalized)) return normalized;
  return SHARED_PROVIDER_SLUG_PATTERN.test(normalized) ? normalized : null;
}

export function parseTtsCredentialBrokerRequest(value: unknown): TtsCredentialBrokerRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'providerRef')) return null;
  const providerRef = normalizeTtsCredentialProviderRef(record.providerRef);
  return providerRef ? { providerRef } : null;
}

export function parseTtsCredentialBrokerResponse(value: unknown): TtsCredentialBrokerResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const providerRef = normalizeTtsCredentialProviderRef(record.providerRef);
  if (
    !providerRef
    || typeof record.providerType !== 'string'
    || !isBuiltInTtsProviderId(record.providerType)
  ) return null;
  if (typeof record.apiKey !== 'string') return null;
  const baseUrl = normalizedOptionalString(record.baseUrl);
  const defaultModel = normalizedOptionalString(record.defaultModel);
  const defaultInstructions = normalizedOptionalString(record.defaultInstructions);
  if (baseUrl === undefined || defaultModel === undefined || defaultInstructions === undefined) return null;
  return {
    providerRef,
    providerType: record.providerType,
    apiKey: record.apiKey,
    baseUrl,
    defaultModel,
    defaultInstructions,
  };
}

export function isTtsCredentialBrokerErrorCode(value: unknown): value is TtsCredentialBrokerErrorCode {
  return typeof value === 'string'
    && (TTS_CREDENTIAL_BROKER_ERROR_CODES as readonly string[]).includes(value);
}

export function parseTtsCredentialBrokerErrorResponse(value: unknown): TtsCredentialBrokerErrorResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  return isTtsCredentialBrokerErrorCode(error) ? { error } : null;
}
