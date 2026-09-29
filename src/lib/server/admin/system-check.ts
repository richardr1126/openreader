import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { getComputeWorkerConfigFromEnv, getComputeWorkerPublicBaseUrl } from '@/lib/server/compute-worker/client';
import { listEnabledAdminProviders } from '@/lib/server/admin/providers';
import { getS3Config, getS3InternalClient, isS3Configured } from '@/lib/server/storage/s3';
import type { SystemCheckItem, SystemCheckReport } from '@/lib/shared/system-check';

export interface SystemCheckDeps {
  env: Record<string, string | undefined>;
  probeWorker: (baseUrl: string) => Promise<void>;
  probeStorage: () => Promise<void>;
  countEnabledProviders: () => Promise<number>;
}

const PROBE_TIMEOUT_MS = 4_000;

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

async function defaultProbeWorker(baseUrl: string): Promise<void> {
  const response = await fetch(new URL('/health/ready', baseUrl), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Worker answered HTTP ${response.status}`);
}

async function defaultProbeStorage(): Promise<void> {
  await getS3InternalClient().send(
    new HeadBucketCommand({ Bucket: getS3Config().bucket }),
    { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
  );
}

const defaultDeps: SystemCheckDeps = {
  env: process.env,
  probeWorker: defaultProbeWorker,
  probeStorage: defaultProbeStorage,
  countEnabledProviders: async () => (await listEnabledAdminProviders()).length,
};

async function checkWorker(deps: SystemCheckDeps): Promise<SystemCheckItem> {
  const label = 'Compute worker';
  let baseUrl: string;
  try {
    baseUrl = getComputeWorkerConfigFromEnv().baseUrl;
  } catch {
    return {
      id: 'worker',
      label,
      status: 'error',
      detail: 'No compute worker is configured for this app.',
      fix: 'Leave COMPUTE_WORKER_URL unset to use the embedded worker, or set COMPUTE_WORKER_URL and COMPUTE_WORKER_TOKEN for an external one.',
    };
  }
  try {
    await deps.probeWorker(baseUrl);
    return { id: 'worker', label, status: 'ok', detail: `Ready at ${new URL(baseUrl).origin}.` };
  } catch (error) {
    return {
      id: 'worker',
      label,
      status: 'error',
      detail: `The app cannot reach the worker at ${new URL(baseUrl).origin}: ${describeError(error)}`,
      fix: 'Check the worker logs. The embedded worker starts with the app; an external worker must be running and reachable from the app server.',
    };
  }
}

async function checkStorage(deps: SystemCheckDeps): Promise<SystemCheckItem> {
  const label = 'Object storage';
  if (!isS3Configured()) {
    return {
      id: 'storage',
      label,
      status: 'error',
      detail: 'S3 storage is not configured.',
      fix: 'Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or use the embedded SeaweedFS defaults.',
    };
  }
  try {
    await deps.probeStorage();
    return { id: 'storage', label, status: 'ok', detail: `Bucket ${getS3Config().bucket} is reachable.` };
  } catch (error) {
    return {
      id: 'storage',
      label,
      status: 'error',
      detail: `The bucket could not be reached: ${describeError(error)}`,
      fix: 'Check S3_INTERNAL_ENDPOINT, the credentials, and that the bucket exists. See Object / Blob Storage in the docs.',
    };
  }
}

function checkPlaybackSecret(deps: SystemCheckDeps): SystemCheckItem {
  const label = 'Playback signing secret';
  if (deps.env.TTS_PLAYBACK_TOKEN_SECRET?.trim()) {
    return {
      id: 'playback-secret',
      label,
      status: 'ok',
      detail: 'Configured. With an external worker it must be the same value on the worker.',
    };
  }
  return {
    id: 'playback-secret',
    label,
    status: 'error',
    detail: 'TTS_PLAYBACK_TOKEN_SECRET is not set, so playback audio cannot be signed.',
    fix: 'Set it to a stable random value (openssl rand -base64 32) on the app and the worker.',
  };
}

async function checkProviders(deps: SystemCheckDeps): Promise<SystemCheckItem> {
  const label = 'TTS provider';
  try {
    const enabled = await deps.countEnabledProviders();
    if (enabled > 0) {
      return { id: 'providers', label, status: 'ok', detail: `${enabled} shared provider${enabled === 1 ? '' : 's'} enabled.` };
    }
    return {
      id: 'providers',
      label,
      status: 'warn',
      detail: 'No shared provider is enabled, so users need their own provider settings to generate audio.',
      fix: 'Add and enable a provider in Settings → Admin → Providers.',
    };
  } catch (error) {
    return {
      id: 'providers',
      label,
      status: 'error',
      detail: `Providers could not be read: ${describeError(error)}`,
    };
  }
}

export async function runSystemCheck(deps: SystemCheckDeps = defaultDeps): Promise<SystemCheckReport> {
  const checks = await Promise.all([
    checkWorker(deps),
    checkStorage(deps),
    Promise.resolve(checkPlaybackSecret(deps)),
    checkProviders(deps),
  ]);
  let workerPublicUrl: string | null = null;
  try {
    workerPublicUrl = getComputeWorkerPublicBaseUrl();
  } catch {
    workerPublicUrl = null;
  }
  return { checks, baseUrl: deps.env.BASE_URL?.trim() || null, workerPublicUrl };
}
