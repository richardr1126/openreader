import { isBuiltInTtsProviderId } from '@/lib/shared/tts-provider-catalog';

export interface SharedProviderSlugEntry {
  slug: string;
}

function normalizeSharedSlug(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  return isBuiltInTtsProviderId(trimmed) ? '' : trimmed;
}

export function resolvePreferredSharedProviderSlug<T extends SharedProviderSlugEntry>(input: {
  providers: readonly T[];
  requestedSlug?: string | null;
  runtimeDefaultSlug?: string | null;
}): string | null {
  const providers = input.providers;
  if (providers.length === 0) return null;

  const bySlug = new Map<string, T>();
  for (const provider of providers) {
    bySlug.set(provider.slug, provider);
  }

  const requested = normalizeSharedSlug(input.requestedSlug);
  if (requested && bySlug.has(requested)) return requested;

  const runtimeDefault = normalizeSharedSlug(input.runtimeDefaultSlug);
  if (runtimeDefault && bySlug.has(runtimeDefault)) return runtimeDefault;

  if (bySlug.has('default-openai')) return 'default-openai';
  return providers[0]?.slug ?? null;
}
