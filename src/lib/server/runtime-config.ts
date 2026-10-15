import { ensureAdminSeed } from '@/lib/server/admin/seed';
import {
  getRuntimeConfig,
  getRuntimeConfigWithSources,
  type RuntimeConfig,
  type RuntimeConfigKey,
  type RuntimeConfigSource,
} from '@/lib/server/admin/settings';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { isAccountEmailEnabled } from '@/lib/server/admin/email-settings';
import { isGutenbergCatalogEnabled } from '@/lib/server/admin/gutendex-settings';
import { configuredDesktopLaunchToken } from '@/lib/server/auth/desktop-launch-token';
import type { ComputeLocation, InstallProfile } from '@/lib/shared/install-profile';

export type ResolvedRuntimeConfig = RuntimeConfig & {
  computeAvailable: boolean;
  accountEmailsEnabled: boolean;
  gutenbergCatalogEnabled: boolean;
  installProfile: InstallProfile;
  computeLocation: ComputeLocation;
};

/**
 * Derived deployment fact, not an admin setting: `desktop` exactly when the
 * desktop shell configured a launch token. Presentation only.
 */
export function resolveInstallProfile(): InstallProfile {
  return configuredDesktopLaunchToken() ? 'desktop' : 'server';
}

/** Vercel sets `VERCEL` itself; there it reaches a hosted worker. */
export function resolveComputeLocation(profile: InstallProfile = resolveInstallProfile()): ComputeLocation {
  if (profile === 'desktop') return 'device';
  return process.env.VERCEL ? 'cloud' : 'server';
}

export type PublicRuntimeConfig = Omit<ResolvedRuntimeConfig, 'computeLimitPolicies'>;

export function publicRuntimeConfig(config: ResolvedRuntimeConfig): PublicRuntimeConfig {
  const { computeLimitPolicies, ...publicConfig } = config;
  void computeLimitPolicies;
  return publicConfig;
}

function assertServerRuntime(caller: string): void {
  if (typeof window !== 'undefined') {
    throw new Error(`${caller} must be called on the server`);
  }
}

/**
 * Returns the resolved site-wide runtime config in the shape consumed by
 * the client via SSR injection. Triggers the boot-time seed on first call
 * so env values land in the DB before the first read.
 */
export async function getResolvedRuntimeConfig(): Promise<ResolvedRuntimeConfig> {
  assertServerRuntime('getResolvedRuntimeConfig');
  await ensureAdminSeed();
  const [values, accountEmailsEnabled, gutenbergCatalogEnabled] = await Promise.all([
    getRuntimeConfig(),
    isAccountEmailEnabled().catch(() => false),
    isGutenbergCatalogEnabled().catch(() => false),
  ]);
  return {
    ...values,
    computeAvailable: isComputeWorkerAvailable(),
    accountEmailsEnabled,
    gutenbergCatalogEnabled,
    installProfile: resolveInstallProfile(),
    computeLocation: resolveComputeLocation(),
  };
}

export async function getResolvedRuntimeConfigWithSources(): Promise<{
  values: RuntimeConfig;
  sources: Record<RuntimeConfigKey, RuntimeConfigSource | 'default'>;
}> {
  assertServerRuntime('getResolvedRuntimeConfigWithSources');
  await ensureAdminSeed();
  return getRuntimeConfigWithSources();
}

export type { RuntimeConfig, RuntimeConfigKey };
