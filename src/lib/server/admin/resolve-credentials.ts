import {
  getEnabledAdminProviderBySlug,
  decryptedKeyFor,
  resolvePreferredEnabledAdminProvider,
  type AdminProviderRecord,
} from '@/lib/server/admin/providers';

export interface ResolvedTtsCredentials {
  /** Provider id passed downstream to TTS generation (one of the 4 built-in IDs). */
  provider: string;
  /** Decrypted API key from the selected admin-managed provider. */
  apiKey: string;
  /** Base URL, or undefined to fall through to provider defaults. */
  baseUrl: string | undefined;
  /** True iff the request was resolved against an admin shared provider. */
  fromAdmin: boolean;
  /** The matched admin provider record, when applicable. */
  adminRecord?: AdminProviderRecord;
}

/**
 * Resolve TTS credentials for an incoming request.
 *
 * Only admin-managed shared providers can supply credentials. Built-in
 * provider ids select the preferred enabled shared provider of that type.
 *
 * Returns `null` when the request references a slug that exists but is
 * disabled — callers should reject with a 4xx.
 */
export async function resolveTtsCredentials(opts: {
  providerHeader: string | null;
  fallbackProvider?: string;
}): Promise<ResolvedTtsCredentials | { error: 'provider_disabled' | 'provider_unknown' | 'no_shared_provider_configured'; slug: string }> {
  const requestedProvider = opts.providerHeader || opts.fallbackProvider || 'openai';

  const admin = isBuiltInProviderId(requestedProvider)
    ? await resolvePreferredEnabledAdminProvider({
      requestedSlug: null,
      runtimeDefaultSlug: opts.fallbackProvider || '',
    })
    : await getEnabledAdminProviderBySlug(requestedProvider);
  if (!admin) {
    return { error: 'no_shared_provider_configured', slug: requestedProvider };
  }

  const apiKey = await decryptedKeyFor(admin);
  return {
    provider: admin.providerType,
    apiKey,
    baseUrl: admin.baseUrl || undefined,
    fromAdmin: true,
    adminRecord: admin,
  };
}

const BUILT_IN_IDS = new Set(['custom-openai', 'replicate', 'deepinfra', 'openai', 'speech-sdk']);

function isBuiltInProviderId(value: string): boolean {
  return BUILT_IN_IDS.has(value);
}
