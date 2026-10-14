// Starts and stops the bundled OpenReader runtime: the bootstrap supervisor,
// which runs SeaweedFS, NATS, the embedded worker and the standalone Next.js app
// exactly as the Docker image does. Every listener binds 127.0.0.1 on a port
// chosen free at launch, and all data lives under the given data directory.
// Plain Node.js, no Electron, so scripts/smoke.mjs runs the same code in CI.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

// Only what the runtime and its tools need from the user's environment. The
// shell never forwards anything else, so a developer's OpenReader settings in
// their shell cannot leak into the desktop app.
const INHERITED_ENV = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ',
];

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The app's AUTH_SECRET: generated once, kept in userData readable only by the user. */
function authSecret(dataDir) {
  const file = path.join(dataDir, 'auth-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function openLog(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'runtime.log');
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { file, fd: fs.openSync(file, 'a') };
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('OpenReader stopped while starting.');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('OpenReader did not start within two minutes.');
}

/**
 * Starts the runtime staged at `root` and resolves once the app answers. `onExit`
 * is called if the runtime stops by itself afterwards.
 */
export async function startRuntime({ root, dataDir, logDir, onExit }) {
  const node = path.join(root, 'node', exe('node'));
  if (!fs.existsSync(node)) {
    throw new Error(`The OpenReader runtime is missing (${root}). Run \`pnpm stage\` first.`);
  }

  const docstore = path.join(dataDir, 'docstore');
  const library = path.join(docstore, 'library');
  fs.mkdirSync(library, { recursive: true });
  const log = openLog(logDir);

  const [appPort, workerPort, natsPort, natsMonitorPort, s3Port] = await Promise.all(
    Array.from({ length: 5 }, freePort),
  );
  const baseUrl = `http://127.0.0.1:${appPort}`;
  // A fresh owner sign-in secret per launch. It exists only in this process and
  // the app's environment (v5/DESKTOP_SINGLE_OWNER.md).
  const launchToken = randomBytes(32).toString('base64url');

  const env = {};
  for (const key of INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    PATH: [path.join(root, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
    // Bootstrap and the worker place their data (SQLite, SeaweedFS, NATS, models)
    // in docstore/ beside the working directory when no checkout is around.
    PWD: dataDir,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    LOG_FORMAT: 'json',
    AUTH_SECRET: authSecret(dataDir),
    DESKTOP_LAUNCH_TOKEN: launchToken,
    BASE_URL: baseUrl,
    HOSTNAME: '127.0.0.1',
    PORT: String(appPort),
    USE_EMBEDDED_WEED_MINI: 'true',
    WEED_MINI_PORT: String(s3Port),
    EMBEDDED_NATS_PORT: String(natsPort),
    EMBEDDED_NATS_MONITOR_PORT: String(natsMonitorPort),
    EMBEDDED_COMPUTE_WORKER_PORT: String(workerPort),
    FFMPEG_BIN: path.join(root, 'ffmpeg', exe('ffmpeg')),
    // The standalone server runs from the read-only bundle, so point the local
    // library at userData instead of its default beside server.js.
    IMPORT_LIBRARY_DIRS: library,
  });

  const child = spawn(
    node,
    [path.join(root, 'bootstrap', 'src', 'cli.mjs'), '--', node, path.join(root, 'app', 'server.js')],
    {
      cwd: dataDir,
      env,
      // The IPC channel is how the shell stops bootstrap (see stopRuntime), and
      // it closes by itself if the shell dies.
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
      windowsHide: true,
    },
  );
  fs.closeSync(log.fd);

  let stopping = false;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve();
      if (!stopping) onExit({ code, signal, logFile: log.file });
    });
  });
  child.once('error', () => {});

  try {
    await waitUntilReady(`${baseUrl}/api/auth/ok`, child);
  } catch (error) {
    stopping = true;
    child.kill();
    error.logFile = log.file;
    throw error;
  }

  return {
    baseUrl,
    launchToken,
    logFile: log.file,
    async stop() {
      if (stopping) return exited;
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Exchanges the launch token for an owner session (v5/DESKTOP_SINGLE_OWNER.md)
 * and returns the Set-Cookie headers.
 */
export async function exchangeLaunchToken(runtime) {
  const response = await fetch(`${runtime.baseUrl}/api/auth/desktop/session`, {
    method: 'POST',
    // Better Auth only accepts JSON request bodies on POST endpoints.
    headers: { Authorization: `Bearer ${runtime.launchToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Owner sign-in failed (${response.status}).`);
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) throw new Error('Owner sign-in returned no session.');
  return cookies;
}
