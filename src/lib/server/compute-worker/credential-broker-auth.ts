import { timingSafeEqual } from 'node:crypto';

export type CredentialBrokerAuthResult = 'authorized' | 'unauthorized' | 'unconfigured';

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function authenticateCredentialBrokerRequest(
  authorization: string | null,
  configuredToken = process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN?.trim() ?? '',
): CredentialBrokerAuthResult {
  if (!configuredToken) return 'unconfigured';
  if (!authorization?.startsWith('Bearer ')) return 'unauthorized';
  const providedToken = authorization.slice('Bearer '.length).trim();
  return providedToken && safeEqual(providedToken, configuredToken)
    ? 'authorized'
    : 'unauthorized';
}
