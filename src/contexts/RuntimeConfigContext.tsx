'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Site-wide runtime config resolved at SSR time and injected via
 * `window.__OPENREADER_RUNTIME_CONFIG__`. Replaces module-scope reads of
 * `process.env.NEXT_PUBLIC_*` so admin edits take effect on the next page
 * load without a redeploy. Read-only from the client; admin writes go
 * through `/api/admin/settings` and trigger a reload.
 *
 * Keep this in sync with `RUNTIME_CONFIG_SCHEMA` on the server.
 */
export interface RuntimeConfig {
  defaultTtsProvider: string;
  restrictUserApiKeys: boolean;
  enableTtsProvidersTab: boolean;
  enableWordHighlight: boolean;
  enableAudiobookExport: boolean;
  enableDocxConversion: boolean;
  enableDestructiveDeleteActions: boolean;
  showAllDeepInfraModels: boolean;
  showAllProviderModels: boolean;
}

const RUNTIME_DEFAULTS: RuntimeConfig = {
  defaultTtsProvider: 'custom-openai',
  restrictUserApiKeys: true,
  enableTtsProvidersTab: true,
  enableWordHighlight: true,
  enableAudiobookExport: true,
  enableDocxConversion: true,
  enableDestructiveDeleteActions: true,
  showAllDeepInfraModels: true,
  showAllProviderModels: true,
};

declare global {
  // Injected via SSR in `src/app/layout.tsx`. Always defined in the browser.
  interface Window {
    __OPENREADER_RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  }
}

function readInjectedConfig(): RuntimeConfig {
  if (typeof window === 'undefined') return { ...RUNTIME_DEFAULTS };
  const injected = window.__OPENREADER_RUNTIME_CONFIG__;
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
