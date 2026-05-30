#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import * as dotenv from 'dotenv';

function loadEnvFiles() {
  const cwd = process.cwd();
  const isCi = isTrue(process.env.CI, false);
  if (isCi) {
    const envCiPath = path.join(cwd, '.env.ci');
    if (fs.existsSync(envCiPath)) {
      dotenv.config({ path: envCiPath });
    }
    return;
  }

  const envPath = path.join(cwd, '.env');
  const envLocalPath = path.join(cwd, '.env.local');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
  }
}

function isTrue(value, defaultValue) {
  if (value == null || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveBooleanEnv(env, key, defaultValue) {
  const value = env[key];
  return isTrue(value, defaultValue);
}

function withDefault(value, fallback) {
  return value && value.trim() ? value.trim() : fallback;
}

function isPrivateIPv4(address) {
  if (!address) return false;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(address);
  if (m) {
    const second = Number.parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function detectHostForDefaultEndpoint() {
  const interfaces = os.networkInterfaces();
  const ipv4 = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry) continue;
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family);
      if (family !== 'IPv4') continue;
      if (entry.internal) continue;
      ipv4.push(entry.address);
    }
  }

  const privateAddr = ipv4.find(isPrivateIPv4);
  if (privateAddr) return privateAddr;
  if (ipv4[0]) return ipv4[0];
  return '127.0.0.1';
}

function parseS3Endpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid S3_ENDPOINT: ${endpoint}`);
  }

  if (!url.hostname) {
    throw new Error(`Invalid S3_ENDPOINT host: ${endpoint}`);
  }

  const port = Number.parseInt(url.port || '8333', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid S3_ENDPOINT port: ${endpoint}`);
  }

  return {
    hostname: url.hostname,
    port,
    normalized: `${url.protocol}//${url.hostname}:${port}`,
  };
}

function loopbackS3Endpoint(endpoint) {
  const parsed = parseS3Endpoint(endpoint);
  const url = new URL(parsed.normalized);
  return `${url.protocol}//127.0.0.1:${parsed.port}`;
}

function parseUrlHost(urlValue, fieldName) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${urlValue}`);
  }

  if (!url.hostname) {
    throw new Error(`Invalid ${fieldName} host: ${urlValue}`);
  }

  return url.hostname;
}

function parseCommandFromArgs(argv) {
  const marker = argv.indexOf('--');
  if (marker >= 0) return argv.slice(marker + 1);
  return argv;
}

function forwardChildStream(stream, target) {
  if (!stream) return () => { };
  const onData = (chunk) => {
    target.write(chunk);
  };
  stream.on('data', onData);
  return () => {
    stream.off('data', onData);
  };
}

function hasWeedBinary() {
  const probe = spawnSync('weed', ['version'], { stdio: 'ignore' });
  if (probe.error) return false;
  return true;
}

function hasNatsBinary() {
  const probe = spawnSync('nats-server', ['-v'], { stdio: 'ignore' });
  if (probe.error) return false;
  return true;
}

async function waitForEndpoint(url, timeoutSeconds) {
  const waitMs = Math.max(1, timeoutSeconds) * 1000;
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (res) return;
    } catch {
      // retry
    } finally {
      clearTimeout(timeoutId);
    }
    await delay(1000);
  }

  throw new Error(`Embedded weed mini did not become ready at ${url} within ${timeoutSeconds}s.`);
}

function isRunningInDocker() {
  if (process.platform !== 'linux') return false;
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /(docker|containerd|kubepods|podman)/i.test(cgroup);
  } catch {
    return false;
  }
}

function spawnMainCommand(command, env) {
  const [cmd, ...args] = command;
  const child = spawn(cmd, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const exitPromise = new Promise((resolve) => {
    child.on('error', (error) => {
      console.error('Failed to launch command:', error);
      resolve({ code: 1, signal: null, launchError: true });
    });

    child.on('exit', (code, signal) => {
      console.error(`Main command exit event: code=${code ?? 'null'} signal=${signal ?? 'null'}.`);
      if (typeof code === 'number') {
        resolve({ code, signal: null, launchError: false });
        return;
      }
      if (signal) {
        resolve({ code: 1, signal, launchError: false });
        return;
      }
      resolve({ code: 0, signal: null, launchError: false });
    });
  });

  return { child, exitPromise };
}

function runDbMigrations(env) {
  const migrateScript = path.join(process.cwd(), 'drizzle', 'scripts', 'migrate.mjs');
  if (!fs.existsSync(migrateScript)) {
    throw new Error(`Could not find migration script at ${migrateScript}`);
  }

  console.log('Running database migrations...');
  const migration = spawnSync(process.execPath, [migrateScript], {
    env,
    stdio: 'inherit',
  });

  if (migration.error) {
    throw migration.error;
  }
  if (typeof migration.status === 'number' && migration.status !== 0) {
    throw new Error(`Database migrations failed with exit code ${migration.status}.`);
  }
}

function runStorageMigrations(env) {
  const migrateScript = path.join(process.cwd(), 'scripts', 'migrate-fs-v2.mjs');
  if (!fs.existsSync(migrateScript)) {
    throw new Error(`Could not find storage migration script at ${migrateScript}`);
  }

  console.log('Running storage migrations (v2)...');
  const migration = spawnSync(process.execPath, [migrateScript, '--dry-run', 'false', '--delete-local', 'false'], {
    env,
    stdio: 'inherit',
  });

  if (migration.error) {
    throw migration.error;
  }
  if (typeof migration.status === 'number' && migration.status !== 0) {
    throw new Error(`Storage migrations failed with exit code ${migration.status}.`);
  }
}

function hasS3Config(env) {
  return Boolean(
    env.S3_BUCKET?.trim()
    && env.S3_REGION?.trim()
    && env.S3_ACCESS_KEY_ID?.trim()
    && env.S3_SECRET_ACCESS_KEY?.trim()
  );
}

function sendSignal(child, signal, useProcessGroup) {
  if (!child) return false;
  if (useProcessGroup && process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateChild(child, signal = 'SIGTERM', graceMs = 3000, useProcessGroup = false) {
  if (!child) return;
  if (child.exitCode != null) return;

  if (!sendSignal(child, signal, useProcessGroup)) return;

  const exited = await Promise.race([
    once(child, 'exit').then(() => true).catch(() => true),
    delay(graceMs).then(() => false),
  ]);

  if (exited) return;

  if (!sendSignal(child, 'SIGKILL', useProcessGroup)) return;

  await Promise.race([
    once(child, 'exit').then(() => true).catch(() => true),
    delay(1000).then(() => false),
  ]);
}

async function main() {
  loadEnvFiles();

  const command = parseCommandFromArgs(process.argv.slice(2));
  if (command.length === 0) {
    console.error('Usage: node scripts/openreader-entrypoint.mjs -- <command> [args]');
    process.exit(2);
  }

  const embeddedEnvRaw = process.env.USE_EMBEDDED_WEED_MINI;
  let useEmbeddedWeed = isTrue(embeddedEnvRaw, true);

  if (useEmbeddedWeed && !hasWeedBinary()) {
    if (embeddedEnvRaw && isTrue(embeddedEnvRaw, true)) {
      console.error('USE_EMBEDDED_WEED_MINI=true but `weed` binary is not available in PATH.');
      process.exit(1);
    }
    useEmbeddedWeed = false;
    console.warn('`weed` binary not found; skipping embedded SeaweedFS startup.');
  }

  const runtimeEnv = { ...process.env };
  runtimeEnv.LOG_FORMAT = withDefault(runtimeEnv.LOG_FORMAT, 'pretty');
  let weedProc = null;
  let weedExitPromise = Promise.resolve();
  let natsProc = null;
  let natsExitPromise = Promise.resolve();
  let workerProc = null;
  let workerExitPromise = Promise.resolve();
  let appProc = null;
  let shutdownPromise = null;
  let isShuttingDown = false;
  let fatalExitScheduled = false;
  let stopWeedStdoutForward = () => { };
  let stopWeedStderrForward = () => { };
  let stopNatsStdoutForward = () => { };
  let stopNatsStderrForward = () => { };
  let stopWorkerStdoutForward = () => { };
  let stopWorkerStderrForward = () => { };
  let didExit = false;

  const exitOnce = (code) => {
    if (didExit) return;
    didExit = true;
    process.exit(code);
  };

  const scheduleFatalShutdown = (serviceName, code, signal, detail) => {
    if (fatalExitScheduled || isShuttingDown || didExit) return;
    fatalExitScheduled = true;
    const codeLabel = typeof code === 'number' ? String(code) : 'null';
    const signalLabel = signal ?? 'null';
    const suffix = detail ? ` (${detail})` : '';
    console.error(
      `Critical service "${serviceName}" exited unexpectedly: code=${codeLabel} signal=${signalLabel}${suffix}. `
      + 'Shutting down all services.',
    );
    void shutdown('SIGTERM').finally(() => exitOnce(typeof code === 'number' && code !== 0 ? code : 1));
  };

  const shutdown = async (signal = 'SIGTERM') => {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    shutdownPromise = (async () => {
      await Promise.all([
        terminateChild(appProc, signal, 4000),
        terminateChild(workerProc, 'SIGTERM', 4000),
        terminateChild(natsProc, 'SIGTERM', 4000),
        terminateChild(weedProc, 'SIGTERM', 4000),
      ]);
      await weedExitPromise;
      await natsExitPromise;
      await workerExitPromise;
      stopWeedStdoutForward();
      stopWeedStderrForward();
      stopNatsStdoutForward();
      stopNatsStderrForward();
      stopWorkerStdoutForward();
      stopWorkerStderrForward();
    })();
    return shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => exitOnce(130));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => exitOnce(143));
  });

  try {
    const shouldRunDbMigrations = resolveBooleanEnv(runtimeEnv, 'RUN_DRIZZLE_MIGRATIONS', true);
    if (shouldRunDbMigrations) {
      runDbMigrations(runtimeEnv);
    }

    if (useEmbeddedWeed) {
      runtimeEnv.WEED_MINI_DIR = withDefault(runtimeEnv.WEED_MINI_DIR, 'docstore/seaweedfs');
      runtimeEnv.WEED_MINI_WAIT_SEC = withDefault(runtimeEnv.WEED_MINI_WAIT_SEC, '20');
      runtimeEnv.S3_BUCKET = withDefault(runtimeEnv.S3_BUCKET, 'openreader-documents');
      runtimeEnv.S3_REGION = withDefault(runtimeEnv.S3_REGION, 'us-east-1');
      const configuredBaseUrl = runtimeEnv.BASE_URL?.trim() || '';
      const baseUrlHost = configuredBaseUrl ? parseUrlHost(configuredBaseUrl, 'BASE_URL') : '';
      const configuredS3Endpoint = runtimeEnv.S3_ENDPOINT?.trim() || '';
      const defaultS3Host = baseUrlHost || detectHostForDefaultEndpoint();
      runtimeEnv.S3_ENDPOINT = configuredS3Endpoint || `http://${defaultS3Host}:8333`;
      runtimeEnv.S3_FORCE_PATH_STYLE = withDefault(runtimeEnv.S3_FORCE_PATH_STYLE, 'true');
      runtimeEnv.S3_PREFIX = withDefault(runtimeEnv.S3_PREFIX, 'openreader');
      runtimeEnv.S3_ACCESS_KEY_ID = withDefault(runtimeEnv.S3_ACCESS_KEY_ID, randomBytes(16).toString('hex'));
      runtimeEnv.S3_SECRET_ACCESS_KEY = withDefault(runtimeEnv.S3_SECRET_ACCESS_KEY, randomBytes(32).toString('hex'));
      runtimeEnv.AWS_ACCESS_KEY_ID = runtimeEnv.S3_ACCESS_KEY_ID;
      runtimeEnv.AWS_SECRET_ACCESS_KEY = runtimeEnv.S3_SECRET_ACCESS_KEY;
      fs.mkdirSync(runtimeEnv.WEED_MINI_DIR, { recursive: true });
      const runningInDocker = isRunningInDocker();
      const waitSec = Number.parseInt(runtimeEnv.WEED_MINI_WAIT_SEC || '20', 10);
      const waitTimeout = Number.isFinite(waitSec) ? waitSec : 20;
      const launchWeed = (endpointUrl) => {
        const parsedEndpoint = parseS3Endpoint(endpointUrl);
        const weedArgs = [
          '-alsologtostderr=false',
          '-stderrthreshold=WARNING',
          'mini',
          `-dir=${runtimeEnv.WEED_MINI_DIR}`,
        ];
        weedArgs.push(`-s3.port=${parsedEndpoint.port}`);
        if (runningInDocker) {
          weedArgs.push('-ip.bind=0.0.0.0');
        }

        weedProc = spawn('weed', weedArgs, {
          env: runtimeEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        stopWeedStdoutForward = forwardChildStream(weedProc.stdout, process.stdout);
        stopWeedStderrForward = forwardChildStream(weedProc.stderr, process.stderr);
        weedExitPromise = once(weedProc, 'exit').then(() => undefined).catch(() => undefined);

        weedProc.on('exit', (code, signal) => {
          if (isShuttingDown) return;
          if (typeof code === 'number' && code !== 0) {
            console.error(`Embedded weed mini exited with code ${code}.`);
          } else if (signal) {
            console.error(`Embedded weed mini exited due to signal ${signal}.`);
          }
          scheduleFatalShutdown('weed mini', code, signal, 'embedded storage service');
        });
      };

      console.log('Starting embedded SeaweedFS weed mini...');
      launchWeed(runtimeEnv.S3_ENDPOINT);
      const startupEndpoint = parseS3Endpoint(runtimeEnv.S3_ENDPOINT);
      await waitForEndpoint(`http://127.0.0.1:${startupEndpoint.port}`, waitTimeout);
      console.log(`Embedded SeaweedFS is ready at ${runtimeEnv.S3_ENDPOINT}`);
    }

    const shouldRunStorageMigrations = resolveBooleanEnv(runtimeEnv, 'RUN_FS_MIGRATIONS', true);
    if (shouldRunStorageMigrations) {
      if (hasS3Config(runtimeEnv)) {
        const migrationEnv = { ...runtimeEnv };
        if (useEmbeddedWeed && migrationEnv.S3_ENDPOINT?.trim()) {
          migrationEnv.S3_ENDPOINT = loopbackS3Endpoint(migrationEnv.S3_ENDPOINT);
        }
        runStorageMigrations(migrationEnv);
      } else {
        console.warn('Skipping storage migrations: S3 configuration is incomplete.');
      }
    }

    const embeddedWorkerPort = Number.parseInt(withDefault(runtimeEnv.EMBEDDED_COMPUTE_WORKER_PORT, '8081'), 10);
    const embeddedNatsPort = Number.parseInt(withDefault(runtimeEnv.EMBEDDED_NATS_PORT, '4222'), 10);
    const embeddedNatsMonitorPort = Number.parseInt(withDefault(runtimeEnv.EMBEDDED_NATS_MONITOR_PORT, '8222'), 10);
    const shouldStartEmbeddedWorker = !Boolean(runtimeEnv.COMPUTE_WORKER_URL?.trim());

    if (shouldStartEmbeddedWorker && !hasNatsBinary()) {
      throw new Error(
        '`nats-server` binary is required when COMPUTE_WORKER_URL is unset. '
        + 'Install nats-server or set COMPUTE_WORKER_URL and COMPUTE_WORKER_TOKEN for an external worker.',
      );
    }

    if (shouldStartEmbeddedWorker) {
      runtimeEnv.NATS_URL = withDefault(runtimeEnv.NATS_URL, `nats://127.0.0.1:${embeddedNatsPort}`);
      runtimeEnv.COMPUTE_WORKER_URL = withDefault(runtimeEnv.COMPUTE_WORKER_URL, `http://127.0.0.1:${embeddedWorkerPort}`);
      runtimeEnv.COMPUTE_WORKER_TOKEN = withDefault(
        runtimeEnv.COMPUTE_WORKER_TOKEN,
        randomBytes(24).toString('base64url'),
      );
      runtimeEnv.COMPUTE_WORKER_HOST = withDefault(runtimeEnv.COMPUTE_WORKER_HOST, '127.0.0.1');
      runtimeEnv.COMPUTE_NATS_REPLICAS = withDefault(runtimeEnv.COMPUTE_NATS_REPLICAS, '1');

      const natsStoreDir = withDefault(runtimeEnv.EMBEDDED_NATS_STORE_DIR, 'docstore/nats/jetstream');
      fs.mkdirSync(natsStoreDir, { recursive: true });

      console.log(`Starting embedded nats-server on 127.0.0.1:${embeddedNatsPort}...`);
      natsProc = spawn(
        'nats-server',
        [
          '-js',
          '-sd', natsStoreDir,
          '-a', '127.0.0.1',
          '-p', String(embeddedNatsPort),
          '-m', String(embeddedNatsMonitorPort),
        ],
        {
          env: runtimeEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      stopNatsStdoutForward = forwardChildStream(natsProc.stdout, process.stdout);
      stopNatsStderrForward = forwardChildStream(natsProc.stderr, process.stderr);
      natsExitPromise = once(natsProc, 'exit').then(() => undefined).catch(() => undefined);
      natsProc.on('exit', (code, signal) => {
        if (isShuttingDown) return;
        if (typeof code === 'number' && code !== 0) {
          console.error(`Embedded nats-server exited with code ${code}.`);
        } else if (signal) {
          console.error(`Embedded nats-server exited due to signal ${signal}.`);
        }
        scheduleFatalShutdown('nats-server', code, signal, 'embedded queue service');
      });
      natsProc.on('error', (error) => {
        console.error(`Embedded nats-server failed to start: ${error instanceof Error ? error.message : String(error)}`);
        scheduleFatalShutdown('nats-server', null, null, 'failed to start');
      });
      await waitForEndpoint(`http://127.0.0.1:${embeddedNatsMonitorPort}/healthz`, 20);
      console.log(`Embedded nats-server is ready at nats://127.0.0.1:${embeddedNatsPort}`);

      console.log(`Starting embedded compute-worker on 127.0.0.1:${embeddedWorkerPort}...`);
      const workerEnv = {
        ...runtimeEnv,
        PORT: String(embeddedWorkerPort),
      };
      workerProc = spawn(
        'pnpm',
        ['--filter', '@openreader/compute-worker', 'start'],
        {
          env: workerEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        },
      );
      stopWorkerStdoutForward = forwardChildStream(workerProc.stdout, process.stdout);
      stopWorkerStderrForward = forwardChildStream(workerProc.stderr, process.stderr);
      workerExitPromise = once(workerProc, 'exit').then(() => undefined).catch(() => undefined);
      workerProc.on('exit', (code, signal) => {
        if (isShuttingDown) return;
        if (typeof code === 'number' && code !== 0) {
          console.error(`Embedded compute-worker exited with code ${code}.`);
        } else if (signal) {
          console.error(`Embedded compute-worker exited due to signal ${signal}.`);
        }
        scheduleFatalShutdown('compute-worker', code, signal, 'embedded compute service');
      });
      workerProc.on('error', (error) => {
        console.error(`Embedded compute-worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
        scheduleFatalShutdown('compute-worker', null, null, 'failed to start');
      });
      await waitForEndpoint(`http://127.0.0.1:${embeddedWorkerPort}/health/ready`, 30);
      console.log(`Embedded compute-worker is ready at http://127.0.0.1:${embeddedWorkerPort}`);
    } else if (!runtimeEnv.COMPUTE_WORKER_URL?.trim() || !runtimeEnv.COMPUTE_WORKER_TOKEN?.trim()) {
      throw new Error('COMPUTE_WORKER_URL and COMPUTE_WORKER_TOKEN are required when embedded compute worker startup is disabled.');
    }

    const { child, exitPromise } = spawnMainCommand(command, runtimeEnv);
    appProc = child;
    const exitInfo = await exitPromise;
    const exitCode = typeof exitInfo?.code === 'number' ? exitInfo.code : 1;
    console.error(
      `Main command finished with code=${exitInfo?.code ?? 'null'} signal=${exitInfo?.signal ?? 'null'} launchError=${Boolean(exitInfo?.launchError)}.`,
    );

    await shutdown('SIGTERM');
    exitOnce(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown('SIGTERM');
    exitOnce(1);
  }
}

await main();
