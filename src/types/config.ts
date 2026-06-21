import type { DocumentListState } from '@/types/documents';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';

export type ViewType = 'single' | 'dual' | 'scroll';

export type SavedVoices = Record<string, string>;

export const TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN = 150;
export const TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX = 1200;
export const TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP = 25;

export function clampTtsSegmentMaxBlockLength(value: number | undefined | null): number {
  const candidate = Math.floor(Number(value) || TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN);
  return Math.max(TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN, Math.min(TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX, candidate));
}

export interface AppConfigValues {
  viewType: ViewType;
  voiceSpeed: number;
  audioPlayerSpeed: number;
  voice: string;
  skipBlank: boolean;
  epubTheme: boolean;
  headerMargin: number;
  footerMargin: number;
  leftMargin: number;
  rightMargin: number;
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  ttsInstructions: string;
  savedVoices: SavedVoices;
  ttsSegmentMaxBlockLength: number;
  pdfHighlightEnabled: boolean;
  pdfWordHighlightEnabled: boolean;
  epubHighlightEnabled: boolean;
  epubWordHighlightEnabled: boolean;
  htmlHighlightEnabled: boolean;
  htmlWordHighlightEnabled: boolean;
  documentListState: DocumentListState;
}

/**
 * Build the static app-config defaults. These no longer read any SSR/admin
 * runtime config: the user's TTS provider defaults to empty ("inherit the
 * admin default"), which is resolved to a concrete provider where it is used
 * (ConfigContext on the client, credential resolution on the server).
 */
export function getAppConfigDefaults(): AppConfigValues {
  // The user's TTS provider is intentionally left empty by default. An empty
  // providerRef means "inherit the instance/admin default" and is resolved to a
  // concrete provider at read time (see ConfigContext) and at generation time
  // (server-side credential resolution). We no longer bake a placeholder
  // provider id (the old 'custom-openai') into every user's config, since that
  // value isn't actually selectable in shared-provider mode.
  return {
    viewType: 'single',
    voiceSpeed: 1,
    audioPlayerSpeed: 1,
    voice: '',
    skipBlank: true,
    epubTheme: false,
    headerMargin: 0,
    footerMargin: 0,
    leftMargin: 0,
    rightMargin: 0,
    providerRef: '',
    providerType: 'unknown',
    ttsModel: '',
    ttsInstructions: '',
    savedVoices: {},
    ttsSegmentMaxBlockLength: 450,
    pdfHighlightEnabled: true,
    pdfWordHighlightEnabled: true,
    epubHighlightEnabled: true,
    epubWordHighlightEnabled: true,
    htmlHighlightEnabled: true,
    htmlWordHighlightEnabled: true,
    documentListState: {
      sortBy: 'name',
      sortDirection: 'asc',
      folders: [],
      collapsedFolders: [],
      showHint: true,
      viewMode: 'grid',
    },
  };
}

/**
 * Static defaults snapshot, resolved once at first access. The values are
 * constant (no SSR/admin overrides are read here anymore), so the lazy Proxy
 * just avoids building the object until something first reads it.
 */
let cachedDefaults: AppConfigValues | null = null;
export const APP_CONFIG_DEFAULTS: AppConfigValues = (() => {
  // Getter-backed object that builds the defaults lazily on first access.
  const handler: ProxyHandler<AppConfigValues> = {
    get(_target, prop) {
      if (!cachedDefaults) cachedDefaults = getAppConfigDefaults();
      return (cachedDefaults as unknown as Record<string | symbol, unknown>)[prop as string];
    },
    has(_target, prop) {
      if (!cachedDefaults) cachedDefaults = getAppConfigDefaults();
      return prop in (cachedDefaults as object);
    },
    ownKeys() {
      if (!cachedDefaults) cachedDefaults = getAppConfigDefaults();
      return Reflect.ownKeys(cachedDefaults as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!cachedDefaults) cachedDefaults = getAppConfigDefaults();
      const value = (cachedDefaults as unknown as Record<string | symbol, unknown>)[prop as string];
      if (value === undefined && !(prop in (cachedDefaults as object))) return undefined;
      return {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      };
    },
  };
  return new Proxy({} as AppConfigValues, handler);
})();

export interface AppConfigRow extends AppConfigValues {
  id: string;
}
