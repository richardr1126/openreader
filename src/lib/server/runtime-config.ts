import { ensureAdminSeed } from '@/lib/server/admin/seed';
import {
  getRuntimeConfig,
  getRuntimeConfigWithSources,
  type RuntimeConfig,
  type RuntimeConfigKey,
  type RuntimeConfigSource,
} from '@/lib/server/admin/settings';
import { isComputeModeAvailable, readComputeMode } from '@/lib/server/compute/mode';

export type ResolvedRuntimeConfig = RuntimeConfig & {
  computeAvailable: boolean;
};

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
  const values = await getRuntimeConfig();
  return {
    ...values,
    computeAvailable: isComputeModeAvailable(readComputeMode()),
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
