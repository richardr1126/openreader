import {
  getEnabledAdminProviderBySlug,
  decryptedKeyFor,
  resolvePreferredEnabledAdminProvider,
  type AdminProviderRecord,
} from '@/lib/server/admin/providers';
import { isBuiltInTtsProviderId, type TtsProviderId } from '@openreader/tts/provider-catalog';

export interface ResolvedTtsCredentials {
  /** Provider id passed downstream to TTS generation. */
  provider: TtsProviderId;
  /** Decrypted API key from the selected admin-managed provider. */
  apiKey: string;
  /** Base URL, or undefined to fall through to provider defaults. */
  baseUrl: string | undefined;
  /** True iff the request was resolved against an admin shared provider. */
  fromAdmin: boolean;
  /** The matched admin provider record, when applicable. */
  adminRecord?: AdminProviderRecord;
}

export class ProviderCredentialDecryptionError extends Error {
  readonly code = 'PROVIDER_DECRYPT_FAILED';

  constructor(options?: { cause?: unknown }) {
    super('Unable to decrypt the selected TTS provider credential', options);
    this.name = 'ProviderCredentialDecryptionError';
  }
}

/**
 * Resolve TTS credentials for an incoming request.
 *
 * Only admin-managed shared providers can supply credentials. Built-in
 * provider ids select the preferred enabled shared provider under the existing
 * legacy selection policy.
 *
 * Returns `null` when the request references a slug that exists but is
 * disabled — callers should reject with a 4xx.
 */
export async function resolveTtsCredentials(opts: {
  providerHeader: string | null;
  fallbackProvider?: string;
}): Promise<ResolvedTtsCredentials | { error: 'provider_disabled' | 'provider_unknown' | 'no_shared_provider_configured'; slug: string }> {
  const requestedProvider = opts.providerHeader || opts.fallbackProvider || 'openai';

  const admin = isBuiltInTtsProviderId(requestedProvider)
    ? await resolvePreferredEnabledAdminProvider({
      requestedSlug: null,
      runtimeDefaultSlug: opts.fallbackProvider || '',
    })
    : await getEnabledAdminProviderBySlug(requestedProvider);
  if (!admin) {
    return { error: 'no_shared_provider_configured', slug: requestedProvider };
  }

  let apiKey: string;
  try {
    apiKey = await decryptedKeyFor(admin);
  } catch (error) {
    throw new ProviderCredentialDecryptionError({ cause: error });
  }
  return {
    provider: admin.providerType,
    apiKey,
    baseUrl: admin.baseUrl || undefined,
    fromAdmin: true,
    adminRecord: admin,
  };
}
