import { SYNCED_PREFERENCE_KEYS, type SyncedPreferencesPatch } from '@/types/user-state';
import { isBuiltInTtsProviderId, isTtsProviderType, type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { resolveProviderDefaults } from '@/lib/shared/tts-provider-policy';

export interface PreferenceNormalizationContext {
  showAllProviderModels: boolean;
  restrictUserApiKeys: boolean;
  sharedProviders: Array<{
    slug: string;
    providerType: TtsProviderId;
    defaultModel: string | null;
    defaultInstructions: string | null;
  }>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeSavedVoices(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof val !== 'string') continue;
    out[key] = val;
  }
  return out;
}

/**
 * Normalize a stored/incoming preferences blob into a clean synced-preferences
 * patch.
 *
 * Provider handling follows an "inherit the admin default" model: an empty
 * `providerRef` means the user has made no explicit choice and should follow the
 * instance default. We deliberately preserve empty rather than collapsing it to
 * a concrete provider, so inheriting users track whatever the admin configures.
 * Built-in provider ids under restricted mode (and the legacy `default-openai`
 * sentinel that isn't a real shared provider) are mapped back to inherit.
 */
export function sanitizePreferencesPatch(
  input: unknown,
  context: PreferenceNormalizationContext,
  options: { fillMissingProvider: boolean },
): { patch: SyncedPreferencesPatch; migrated: boolean } {
  if (!isRecord(input)) return { patch: {}, migrated: false };

  const rec = input as Record<string, unknown>;
  const out: SyncedPreferencesPatch = {};
  let migrated = false;

  const legacyProviderRef = typeof rec.ttsProvider === 'string'
    ? rec.ttsProvider
    : typeof rec.provider === 'string'
      ? rec.provider
      : '';
  const hasLegacyProviderKey = typeof rec.ttsProvider === 'string' || typeof rec.provider === 'string';
  const hasProviderRefKey = typeof rec.providerRef === 'string';
  const rawProviderRef = hasProviderRefKey ? (rec.providerRef as string) : legacyProviderRef;

  const sharedSlugs = new Set(context.sharedProviders.map((entry) => entry.slug));
  let providerRefIntent = typeof rawProviderRef === 'string' ? rawProviderRef.trim() : '';
  // Legacy 'default-openai' sentinel: only honored when it's a real configured
  // shared provider; otherwise it historically meant "use the default" → inherit.
  if (providerRefIntent === 'default-openai' && !sharedSlugs.has('default-openai')) {
    providerRefIntent = '';
  }
  // Built-in providers aren't selectable under restricted mode → inherit. This
  // also migrates the old baked-in 'custom-openai' default off existing rows.
  if (context.restrictUserApiKeys && isBuiltInTtsProviderId(providerRefIntent)) {
    providerRefIntent = '';
  }
  const providerRefIsExplicit = providerRefIntent.length > 0;
  const providerDefaults = providerRefIsExplicit
    ? resolveProviderDefaults({
      providerRef: providerRefIntent,
      providerType: isTtsProviderType(rec.providerType) ? rec.providerType : 'unknown',
      sharedProviders: context.sharedProviders,
    })
    : null;

  if (hasLegacyProviderKey || (hasProviderRefKey && (rec.providerRef as string) !== providerRefIntent)) {
    migrated = true;
  }

  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (!(key in rec)) continue;
    const value = rec[key];

    switch (key) {
      case 'viewType':
        if (value === 'single' || value === 'dual' || value === 'scroll') out[key] = value;
        break;
      case 'voice':
      case 'ttsInstructions':
        if (typeof value === 'string') out[key] = value;
        break;
      // providerRef / providerType / ttsModel are resolved together below.
      case 'providerRef':
      case 'providerType':
      case 'ttsModel':
        break;
      case 'voiceSpeed':
      case 'audioPlayerSpeed':
      case 'segmentPreloadDepthPages':
      case 'segmentPreloadSentenceLookahead':
      case 'ttsSegmentMaxBlockLength':
      case 'headerMargin':
      case 'footerMargin':
      case 'leftMargin':
      case 'rightMargin':
        if (Number.isFinite(value)) out[key] = Number(value);
        break;
      case 'skipBlank':
      case 'epubTheme':
      case 'pdfHighlightEnabled':
      case 'pdfWordHighlightEnabled':
      case 'epubHighlightEnabled':
      case 'epubWordHighlightEnabled':
      case 'htmlHighlightEnabled':
      case 'htmlWordHighlightEnabled':
        if (typeof value === 'boolean') out[key] = value;
        break;
      case 'savedVoices':
        out[key] = sanitizeSavedVoices(value);
        break;
      default:
        break;
    }
  }

  // Persist concrete provider/type/model only for an explicit selection. An
  // inheriting user keeps these empty so resolution happens against the live
  // admin default at read/generation time.
  const shouldWriteProvider = hasProviderRefKey || hasLegacyProviderKey || options.fillMissingProvider;
  if (shouldWriteProvider) {
    out.providerRef = providerRefIntent;
    out.providerType = providerRefIsExplicit ? providerDefaults!.providerType : 'unknown';
  }

  if (providerRefIsExplicit) {
    const rawModel = typeof rec.ttsModel === 'string' ? rec.ttsModel.trim() : '';
    const lockedToDefault = !context.showAllProviderModels && !!providerDefaults!.defaultModel;
    const model = lockedToDefault
      ? providerDefaults!.defaultModel
      : (rawModel || providerDefaults!.defaultModel);
    if (model) {
      out.ttsModel = model;
      if (model !== rawModel) migrated = true;
    } else if (typeof rec.ttsModel === 'string') {
      out.ttsModel = rec.ttsModel;
    }
  } else if (shouldWriteProvider || 'ttsModel' in rec) {
    // Inheriting: the model inherits too.
    if (typeof rec.ttsModel === 'string' && rec.ttsModel !== '') migrated = true;
    out.ttsModel = '';
  }

  return { patch: out, migrated };
}
