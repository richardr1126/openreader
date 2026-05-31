'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Site-wide runtime config resolved at SSR time and injected via
 * `window.__RUNTIME_CONFIG__`. Replaces module-scope reads of
 * build-time public env flags so admin edits take effect on the next page
 * load without a redeploy. Read-only from the client; admin writes go
 * through `/api/admin/settings` and trigger a reload.
 *
 * Keep this in sync with `RUNTIME_CONFIG_SCHEMA` on the server.
 */
export interface RuntimeConfig {
  defaultTtsProvider: string;
  changelogFeedUrl: string;
  appVersion: string;
  enableUserSignups: boolean;
  restrictUserApiKeys: boolean;
  enableTtsProvidersTab: boolean;
  enableAudiobookExport: boolean;
  enableDocxConversion: boolean;
  enableDestructiveDeleteActions: boolean;
  showAllProviderModels: boolean;
  disableTtsRateLimit: boolean;
  ttsDailyLimitAnonymous: number;
  ttsDailyLimitAuthenticated: number;
  ttsIpDailyLimitAnonymous: number;
  ttsIpDailyLimitAuthenticated: number;
  ttsCacheMaxSizeBytes: number;
  ttsCacheTtlMs: number;
  ttsUpstreamMaxRetries: number;
  ttsUpstreamTimeoutMs: number;
  computeAvailable: boolean;
}

const RUNTIME_DEFAULTS: RuntimeConfig = {
  defaultTtsProvider: 'custom-openai',
  changelogFeedUrl: 'https://docs.openreader.richardr.dev/changelog/manifest.json',
  appVersion: '0.0.0',
  enableUserSignups: true,
  restrictUserApiKeys: true,
  enableTtsProvidersTab: true,
  enableAudiobookExport: true,
  enableDocxConversion: true,
  enableDestructiveDeleteActions: true,
  showAllProviderModels: true,
  disableTtsRateLimit: true,
  ttsDailyLimitAnonymous: 50_000,
  ttsDailyLimitAuthenticated: 500_000,
  ttsIpDailyLimitAnonymous: 100_000,
  ttsIpDailyLimitAuthenticated: 1_000_000,
  ttsCacheMaxSizeBytes: 256 * 1024 * 1024,
  ttsCacheTtlMs: 1000 * 60 * 30,
  ttsUpstreamMaxRetries: 2,
  ttsUpstreamTimeoutMs: 285_000,
  computeAvailable: true,
};

declare global {
  // Injected via SSR in `src/app/layout.tsx`. Always defined in the browser.
  interface Window {
    __RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  }
}

function readInjectedConfig(): RuntimeConfig {
  if (typeof window === 'undefined') return { ...RUNTIME_DEFAULTS };
  const injected = window.__RUNTIME_CONFIG__;
  if (!injected || typeof injected !== 'object') return { ...RUNTIME_DEFAULTS };
  return { ...RUNTIME_DEFAULTS, ...injected };
}

const RuntimeConfigContext = createContext<RuntimeConfig>({ ...RUNTIME_DEFAULTS });

export function RuntimeConfigProvider({
  children,
  value,
}: {
  children: ReactNode;
  /** Optional override (for tests). When omitted, reads from window. */
  value?: RuntimeConfig;
}) {
  const resolved = useMemo<RuntimeConfig>(() => value ?? readInjectedConfig(), [value]);
  return <RuntimeConfigContext.Provider value={resolved}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  return useContext(RuntimeConfigContext);
}

export function useFeatureFlag<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] {
  const cfg = useRuntimeConfig();
  return cfg[key];
}

/**
 * Synchronous accessor for modules that are loaded before the React tree
 * mounts (e.g. Dexie initialization, config defaults). Falls back to the
 * built-in defaults during SSR.
 */
export function readRuntimeConfigSync(): RuntimeConfig {
  return readInjectedConfig();
}
