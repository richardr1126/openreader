import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

const storageTransportConsumers = [
  'src/instrumentation.node.ts',
  'src/lib/server/storage/s3.ts',
  'packages/bootstrap/src/cli.mjs',
  'packages/compute-worker/src/api/app.ts',
  'packages/compute-worker/src/infrastructure/storage.ts',
];

const documentedEnvironmentVariables = [
  'ADMIN_EMAILS',
  'API_BASE',
  'API_KEY',
  'AUTH_SECRET',
  'AUTH_TRUSTED_ORIGINS',
  'BASE_URL',
  'CHANGELOG_FORCE_FULL',
  'CHANGELOG_MUTABLE_COUNT',
  'CHANGELOG_PUBLIC_BASE_URL',
  'CHANGELOG_REPO',
  'CI',
  'COMPUTE_EVENTS_STREAM_MAX_BYTES',
  'COMPUTE_JOB_CONCURRENCY',
  'COMPUTE_JOB_STATES_MAX_BYTES',
  'COMPUTE_JOBS_STREAM_MAX_BYTES',
  'COMPUTE_LOG_LEVEL',
  'COMPUTE_NATS_REPLICAS',
  'COMPUTE_OP_STALE_MS',
  'COMPUTE_PDF_JOB_ATTEMPTS',
  'COMPUTE_PDF_TIMEOUT_MS',
  'COMPUTE_PREWARM_MODELS',
  'COMPUTE_TTS_PLAYBACK_SEGMENT_TIMEOUT_MS',
  'COMPUTE_WHISPER_TIMEOUT_MS',
  'COMPUTE_WORKER_HOST',
  'COMPUTE_WORKER_PUBLIC_URL',
  'COMPUTE_WORKER_TOKEN',
  'COMPUTE_WORKER_URL',
  'CRON_SECRET',
  'DISABLE_AUTH_RATE_LIMIT',
  'EMBEDDED_COMPUTE_WORKER_PORT',
  'EMBEDDED_NATS_MONITOR_PORT',
  'EMBEDDED_NATS_PORT',
  'EMBEDDED_NATS_STORE_DIR',
  'ENABLE_TEST_NAMESPACE',
  'FFMPEG_BIN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'IMPORT_LIBRARY_DIRS',
  'LOG_FORMAT',
  'LOG_LEVEL',
  'NATS_CREDS',
  'NATS_CREDS_FILE',
  'NATS_URL',
  'NEXT_RUNTIME',
  'NODE_ENV',
  'PDF_LAYOUT_MODEL_BASE_URL',
  'PORT',
  'POSTGRES_URL',
  'PWD',
  'RICHARDRDEV_PRODUCTION',
  'RUNTIME_SEED_JSON',
  'RUNTIME_SEED_JSON_PATH',
  'RUN_DRIZZLE_MIGRATIONS',
  'RUN_V4_DECOMMISSION',
  'S3_ACCESS_KEY_ID',
  'S3_BROWSER_TRANSPORT',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'S3_INTERNAL_ENDPOINT',
  'S3_PREFIX',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
  'TTS_PLAYBACK_TOKEN_SECRET',
  'USE_ANONYMOUS_AUTH_SESSIONS',
  'USE_EMBEDDED_WEED_MINI',
  'VERCEL',
  'WEED_MINI_ADVERTISE_HOST',
  'WEED_MINI_BIND_HOST',
  'WEED_MINI_DIR',
  'WEED_MINI_PORT',
  'WEED_MINI_WAIT_SEC',
  'WHISPER_MODEL_BASE_URL',
] as const;

describe('shared runtime configuration boundary', () => {
  test('exports one pure storage transport resolver through a workspace package', () => {
    const packageJson = JSON.parse(source('packages/runtime-config/package.json')) as {
      exports?: Record<string, string>;
    };
    const resolver = source('packages/runtime-config/src/storage-transport.mjs');

    expect(packageJson.exports?.['./storage-transport']).toBe('./src/storage-transport.mjs');
    expect(resolver).not.toMatch(/^import /m);
    expect(resolver).not.toContain('env.S3_INTERNAL_ENDPOINT =');
    expect(resolver).not.toContain('env.S3_BROWSER_TRANSPORT =');
  });

  test('makes bootstrap, Next, and worker consume the package boundary', () => {
    for (const consumerPath of storageTransportConsumers) {
      const consumer = source(consumerPath);
      expect(consumer, consumerPath).toContain("from '@openreader/runtime-config/storage-transport'");
      expect(consumer, consumerPath).not.toContain('packages/bootstrap/src/storage-transport');
      expect(consumer, consumerPath).not.toContain('bootstrap/src/storage-transport');
    }

    const bootstrap = source('packages/bootstrap/src/cli.mjs');
    expect(bootstrap).toContain('env.S3_INTERNAL_ENDPOINT = resolved.internalEndpoint');
    expect(bootstrap).toContain('env.S3_BROWSER_TRANSPORT = resolved.mode');
  });

  test('keeps the active environment inventory and deployment examples canonical', () => {
    const reference = source('docs-site/docs/reference/environment-variables.md');
    const rootExample = source('.env.example');
    const workerExample = source('packages/compute-worker/.env.example');
    const fullCompose = source('docker/examples/compose.full.yml');

    for (const variable of documentedEnvironmentVariables) {
      expect(reference, `${variable} is missing from the environment reference`).toContain(`\`${variable}\``);
    }

    expect(rootExample).not.toContain('IMPORT_LIBRARY_DIR=');
    expect(reference).not.toContain('### IMPORT_LIBRARY_DIR\n');
    expect(workerExample).toContain('AUTH_SECRET=local-openreader-auth-secret-change-me');
    expect(fullCompose).toContain('AUTH_SECRET: ${AUTH_SECRET:-local-openreader-auth-secret-change-me}');
  });
});
