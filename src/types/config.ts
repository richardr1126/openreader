import type { DocumentListState } from '@/types/documents';
import { isBuiltInTtsProviderId, type TtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { defaultModelForProviderType } from '@/lib/shared/tts-provider-policy';

// Runtime config (admin-controlled) is layered on top of the static defaults
// below. We resolve it lazily so this module stays importable from non-React
// contexts (Dexie, server routes). The actual values come from
// `window.__RUNTIME_CONFIG__` (SSR-injected) on the client, and
// from the built-in defaults during SSR.

function readRuntimeString(key: string, defaultValue: string): string {
  if (typeof window === 'undefined') return defaultValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injected = (window as any).__RUNTIME_CONFIG__;
  if (!injected || typeof injected !== 'object') return defaultValue;
  const value = injected[key];
  return typeof value === 'string' && value ? value : defaultValue;
}

export type ViewType = 'single' | 'dual' | 'scroll';

export type SavedVoices = Record<string, string>;

export const SEGMENT_PRELOAD_DEPTH_MIN = 1;
export const SEGMENT_PRELOAD_DEPTH_MAX = 5;
export const SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MIN = 1;
export const SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MAX = 10;
export const TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN = 150;
export const TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX = 1200;
export const TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP = 25;

export function clampSegmentPreloadDepth(value: number | undefined | null): number {
  const candidate = Math.floor(Number(value) || SEGMENT_PRELOAD_DEPTH_MIN);
  return Math.max(SEGMENT_PRELOAD_DEPTH_MIN, Math.min(SEGMENT_PRELOAD_DEPTH_MAX, candidate));
}

export function clampSegmentPreloadSentenceLookahead(value: number | undefined | null): number {
  const candidate = Math.floor(Number(value) || SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MIN);
  return Math.max(SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MIN, Math.min(SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MAX, candidate));
}

export function clampTtsSegmentMaxBlockLength(value: number | undefined | null): number {
  const candidate = Math.floor(Number(value) || TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN);
  return Math.max(TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN, Math.min(TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX, candidate));
}

export interface AppConfigValues {
  apiKey: string;
  baseUrl: string;
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
  segmentPreloadDepthPages: number;
  segmentPreloadSentenceLookahead: number;
  ttsSegmentMaxBlockLength: number;
  pdfHighlightEnabled: boolean;
  pdfWordHighlightEnabled: boolean;
  epubHighlightEnabled: boolean;
  epubWordHighlightEnabled: boolean;
  htmlHighlightEnabled: boolean;
  htmlWordHighlightEnabled: boolean;
  firstVisit: boolean;
  documentListState: DocumentListState;
  privacyAccepted: boolean;
  documentsMigrationPrompted: boolean;
}

/**
 * Build defaults lazily so we can read SSR-injected admin overrides
 * (`window.__RUNTIME_CONFIG__`). Modules that need the defaults
 * statically should call `getAppConfigDefaults()` at use time. The exported
 * `APP_CONFIG_DEFAULTS` is a Proxy that re-resolves on each access so
 * mutations to the runtime config (admin edits) are picked up by anything
 * that reads through it.
 */
export function getAppConfigDefaults(): AppConfigValues {
  const runtimeProviderRef = readRuntimeString('defaultTtsProvider', 'custom-openai');
  const defaultProviderRef = runtimeProviderRef.trim();
  const defaultProviderType = isBuiltInTtsProviderId(defaultProviderRef) ? defaultProviderRef : 'unknown';
  const defaultModel = isBuiltInTtsProviderId(defaultProviderType)
    ? defaultModelForProviderType(defaultProviderType)
    : 'kokoro';
  return {
    apiKey: '',
    baseUrl: '',
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
    providerRef: defaultProviderRef,
    providerType: defaultProviderType,
    ttsModel: defaultModel,
    ttsInstructions: '',
    savedVoices: {},
    segmentPreloadDepthPages: 1,
    segmentPreloadSentenceLookahead: 3,
    ttsSegmentMaxBlockLength: 450,
    pdfHighlightEnabled: true,
    pdfWordHighlightEnabled: true,
    epubHighlightEnabled: true,
    epubWordHighlightEnabled: true,
    htmlHighlightEnabled: true,
    htmlWordHighlightEnabled: true,
    firstVisit: false,
    documentListState: {
      sortBy: 'name',
      sortDirection: 'asc',
      folders: [],
      collapsedFolders: [],
      showHint: true,
      viewMode: 'grid',
    },
    privacyAccepted: false,
    documentsMigrationPrompted: false,
  };
}

/**
 * Static defaults snapshot resolved at first access. For callers that need
 * fresh values after admin edits, prefer `getAppConfigDefaults()` directly.
 * Most consumers just need a stable defaults object for spreads, so this is
 * resolved once per process — admin overrides take effect on next page load
 * (which is the SSR-injected behavior we want anyway).
 */
let cachedDefaults: AppConfigValues | null = null;
export const APP_CONFIG_DEFAULTS: AppConfigValues = (() => {
  // Return a getter-backed object that resolves on first access. On the
  // server, this resolves to built-in defaults; on the client, to the
  // SSR-injected admin values.
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
