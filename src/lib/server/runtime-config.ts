import 'server-only';
import { ensureAdminSeed } from '@/lib/server/admin/seed';
import {
  getRuntimeConfig,
  getRuntimeConfigWithSources,
  type RuntimeConfig,
  type RuntimeConfigKey,
  type RuntimeConfigSource,
} from '@/lib/server/admin/settings';

export type ResolvedRuntimeConfig = RuntimeConfig;

/**
 * Returns the resolved site-wide runtime config in the shape consumed by
 * the client via SSR injection. Triggers the boot-time seed on first call
 * so env values land in the DB before the first read.
 */
export async function getResolvedRuntimeConfig(): Promise<ResolvedRuntimeConfig> {
  await ensureAdminSeed();
  return getRuntimeConfig();
}

export async function getResolvedRuntimeConfigWithSources(): Promise<{
  values: RuntimeConfig;
  sources: Record<RuntimeConfigKey, RuntimeConfigSource | 'default'>;
}> {
  await ensureAdminSeed();
  return getRuntimeConfigWithSources();
}

export type { RuntimeConfig, RuntimeConfigKey };
