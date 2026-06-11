import {
  getEnabledAdminProviderBySlug,
  decryptedKeyFor,
  resolvePreferredEnabledAdminProvider,
  type AdminProviderRecord,
} from '@/lib/server/admin/providers';

export interface ResolvedTtsCredentials {
  /** Provider id passed downstream to TTS generation (one of the 4 built-in IDs). */
  provider: string;
  /** API key for the request. Empty string when neither admin nor user supplied one. */
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
 * 1. If `restrictUserApiKeys` is enabled, only admin shared providers are
 *    used. Built-in provider ids and user-supplied key/base headers are
 *    ignored.
 * 2. If `providerHeader` matches an enabled admin provider slug, use its
 *    server-stored credentials. Any `x-openai-key` / `x-openai-base-url`
 *    headers from the client are ignored — admin keys must never round-trip
 *    through the client.
 * 3. Otherwise, treat `providerHeader` as a built-in provider id and use the
 *    per-user `x-openai-key` / `x-openai-base-url` headers as today.
 *
 * Returns `null` when the request references a slug that exists but is
 * disabled — callers should reject with a 4xx.
 */
export async function resolveTtsCredentials(opts: {
  providerHeader: string | null;
  apiKeyHeader: string | null;
  baseUrlHeader: string | null;
  fallbackProvider?: string;
  restrictUserApiKeys?: boolean;
}): Promise<ResolvedTtsCredentials | { error: 'provider_disabled' | 'provider_unknown' | 'no_shared_provider_configured'; slug: string }> {
  const requestedProvider = opts.providerHeader || opts.fallbackProvider || 'openai';

  if (opts.restrictUserApiKeys) {
    const requestedIsBuiltIn = isBuiltInProviderId(requestedProvider);
    const fallback = opts.fallbackProvider || '';
    const selected = await resolvePreferredEnabledAdminProvider({
      requestedSlug: requestedIsBuiltIn ? null : requestedProvider,
      runtimeDefaultSlug: fallback,
    });
    if (!selected) {
      return { error: 'no_shared_provider_configured', slug: requestedProvider };
    }
    const apiKey = await decryptedKeyFor(selected);
    return {
      provider: selected.providerType,
      apiKey,
      baseUrl: selected.baseUrl || undefined,
      fromAdmin: true,
      adminRecord: selected,
    };
  }

  // Built-in provider ids are not admin slugs — short-circuit.
  if (isBuiltInProviderId(requestedProvider)) {
    return {
      provider: requestedProvider,
      apiKey: opts.apiKeyHeader || '',
      baseUrl: opts.baseUrlHeader || undefined,
      fromAdmin: false,
    };
  }

  // Not a built-in id → try to look it up as an admin slug.
  const admin = await getEnabledAdminProviderBySlug(requestedProvider);
  if (!admin) {
    return { error: 'provider_unknown', slug: requestedProvider };
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
