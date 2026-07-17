#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import * as dotenv from 'dotenv';
import { runMigrations } from '@openreader/database/migrate';
import { runV4Decommission } from './decommission-v4.mjs';
import { hasNatsBinary } from './embedded-nats.mjs';
import {
  hasWeedBinary,
  resolveWeedMiniAdvertiseHost,
  waitForEndpoint,
} from './embedded-seaweedfs.mjs';
import { resolveEmbeddedWorkerLaunch } from './embedded-worker.mjs';
import { applyStorageTransportEnv } from './storage-transport.mjs';

function findWorkspaceRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return startDir;
}

const workspaceRoot = findWorkspaceRoot(process.cwd());

function loadEnvFiles() {
  const envPath = path.join(workspaceRoot, '.env');
  const envLocalPath = path.join(workspaceRoot, '.env.local');

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

function requireAuthEnv(env) {
  const missing = [];
  if (!env.AUTH_SECRET?.trim()) missing.push('AUTH_SECRET');
  if (!env.BASE_URL?.trim()) missing.push('BASE_URL');
  if (missing.length > 0) {
    throw new Error(
      `Missing required auth env vars: ${missing.join(', ')}. `
      + 'OpenReader v4 requires both AUTH_SECRET and BASE_URL at startup.',
    );
  }
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

function spawnMainCommand(command, env) {
  const [cmd, ...args] = command;
  const child = spawn(cmd, args, {
    cwd: workspaceRoot,
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

async function runDbMigrations(env) {
  console.log('Running database migrations...');
  await runMigrations({ cwd: workspaceRoot, env });
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
    console.error('Usage: openreader -- <command> [args]');
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
  requireAuthEnv(runtimeEnv);
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
      await runDbMigrations(runtimeEnv);
    }

    if (useEmbeddedWeed) {
      runtimeEnv.WEED_MINI_DIR = withDefault(runtimeEnv.WEED_MINI_DIR, path.join(workspaceRoot, 'docstore/seaweedfs'));
      runtimeEnv.WEED_MINI_WAIT_SEC = withDefault(runtimeEnv.WEED_MINI_WAIT_SEC, '20');
      runtimeEnv.WEED_MINI_BIND_HOST = withDefault(runtimeEnv.WEED_MINI_BIND_HOST, '127.0.0.1');
      runtimeEnv.WEED_MINI_ADVERTISE_HOST = resolveWeedMiniAdvertiseHost(
        runtimeEnv.WEED_MINI_BIND_HOST,
        runtimeEnv.WEED_MINI_ADVERTISE_HOST,
      );
      runtimeEnv.WEED_MINI_PORT = withDefault(runtimeEnv.WEED_MINI_PORT, '8333');
      runtimeEnv.S3_BUCKET = withDefault(runtimeEnv.S3_BUCKET, 'openreader-documents');
      runtimeEnv.S3_REGION = withDefault(runtimeEnv.S3_REGION, 'us-east-1');
      runtimeEnv.S3_INTERNAL_ENDPOINT = withDefault(
        runtimeEnv.S3_INTERNAL_ENDPOINT || runtimeEnv.S3_ENDPOINT,
        `http://127.0.0.1:${runtimeEnv.WEED_MINI_PORT}`,
      );
      runtimeEnv.S3_FORCE_PATH_STYLE = withDefault(runtimeEnv.S3_FORCE_PATH_STYLE, 'true');
      runtimeEnv.S3_PREFIX = withDefault(runtimeEnv.S3_PREFIX, 'openreader');
      runtimeEnv.S3_ACCESS_KEY_ID = withDefault(runtimeEnv.S3_ACCESS_KEY_ID, randomBytes(16).toString('hex'));
      runtimeEnv.S3_SECRET_ACCESS_KEY = withDefault(runtimeEnv.S3_SECRET_ACCESS_KEY, randomBytes(32).toString('hex'));
      runtimeEnv.AWS_ACCESS_KEY_ID = runtimeEnv.S3_ACCESS_KEY_ID;
      runtimeEnv.AWS_SECRET_ACCESS_KEY = runtimeEnv.S3_SECRET_ACCESS_KEY;
      fs.mkdirSync(runtimeEnv.WEED_MINI_DIR, { recursive: true });
      const waitSec = Number.parseInt(runtimeEnv.WEED_MINI_WAIT_SEC || '20', 10);
      const waitTimeout = Number.isFinite(waitSec) ? waitSec : 20;
      const launchWeed = () => {
        const weedArgs = [
          '-alsologtostderr=false',
          '-stderrthreshold=WARNING',
          'mini',
          `-dir=${runtimeEnv.WEED_MINI_DIR}`,
        ];
        weedArgs.push(`-s3.port=${runtimeEnv.WEED_MINI_PORT}`);
        weedArgs.push(`-ip=${runtimeEnv.WEED_MINI_ADVERTISE_HOST}`);
        weedArgs.push(`-ip.bind=${runtimeEnv.WEED_MINI_BIND_HOST}`);

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
      launchWeed();
      await waitForEndpoint(`http://127.0.0.1:${runtimeEnv.WEED_MINI_PORT}`, waitTimeout, 'Embedded SeaweedFS');
      console.log(`Embedded SeaweedFS is ready at ${runtimeEnv.S3_INTERNAL_ENDPOINT}`);
    }

    const storageTransport = applyStorageTransportEnv(runtimeEnv, { embedded: useEmbeddedWeed });
    if (storageTransport.usesDeprecatedEndpoint) {
      console.warn('S3_ENDPOINT is deprecated; configure S3_INTERNAL_ENDPOINT and S3_PUBLIC_ENDPOINT. S3_ENDPOINT will be removed in the next major release.');
    }

    const shouldRunV4Decommission = resolveBooleanEnv(runtimeEnv, 'RUN_V4_DECOMMISSION', true);
    if (shouldRunV4Decommission) {
      if (hasS3Config(runtimeEnv)) {
        const decommissionEnv = { ...runtimeEnv };
        await runV4Decommission(decommissionEnv);
      } else {
        console.warn('Skipping v4 legacy storage decommission: S3 configuration is incomplete.');
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

      const natsStoreDir = withDefault(runtimeEnv.EMBEDDED_NATS_STORE_DIR, path.join(workspaceRoot, 'docstore/nats/jetstream'));
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
      await waitForEndpoint(`http://127.0.0.1:${embeddedNatsMonitorPort}/healthz`, 20, 'Embedded nats-server');
      console.log(`Embedded nats-server is ready at nats://127.0.0.1:${embeddedNatsPort}`);

      console.log(`Starting embedded compute-worker on 127.0.0.1:${embeddedWorkerPort}...`);
      const workerEnv = {
        ...runtimeEnv,
        PORT: String(embeddedWorkerPort),
      };
      const workerLaunch = resolveEmbeddedWorkerLaunch();
      workerProc = spawn(
        workerLaunch.cmd,
        workerLaunch.args,
        {
          cwd: workerLaunch.cwd,
          env: workerEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
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
      await waitForEndpoint(`http://127.0.0.1:${embeddedWorkerPort}/health/ready`, 30, 'Embedded compute-worker');
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
