#!/usr/bin/env node
// Starts the staged runtime the way the shell does, in throwaway directories,
// and checks the parts the window depends on: the app answers, the launch token
// signs the owner in (and nothing else does), the token stays out of the log,
// and the runtime stops cleanly. Run `pnpm stage` first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchangeLaunchToken, startRuntime } from '../src/runtime.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let logFile = null;

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`[smoke] ok: ${message}`);
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-smoke-'));
  const dataDir = path.join(work, 'data');
  const logDir = path.join(work, 'logs');
  fs.mkdirSync(dataDir);

  let exitedEarly = null;
  const started = Date.now();
  const runtime = await startRuntime({
    root: path.join(desktopDir, 'stage', 'runtime'),
    dataDir,
    logDir,
    onExit: (exit) => {
      exitedEarly = exit;
    },
  });
  logFile = runtime.logFile;
  console.log(`[smoke] runtime ready in ${((Date.now() - started) / 1000).toFixed(1)} s at ${runtime.baseUrl}`);

  try {
    const rejected = await exchangeLaunchToken({ ...runtime, launchToken: 'not-the-launch-token' }).then(
      () => null,
      (error) => error,
    );
    check(rejected?.message.includes('(401)'), 'a wrong launch token is refused');

    const cookies = await exchangeLaunchToken(runtime);
    const cookie = cookies.map((header) => header.split(';')[0]).join('; ');
    check(cookies.some((header) => /HttpOnly/i.test(header)), 'the launch token returns an HttpOnly session cookie');

    const response = await fetch(`${runtime.baseUrl}/api/auth/get-session`, { headers: { cookie } });
    const body = await response.json();
    check(response.ok && body?.user?.isAdmin === true, 'the session belongs to the admin owner');

    const app = await fetch(`${runtime.baseUrl}/app`, { headers: { cookie }, redirect: 'manual' });
    check(app.status === 200, 'the signed-in owner gets /app without a redirect');
  } finally {
    await runtime.stop();
  }

  check(exitedEarly === null, 'the runtime ran until it was stopped');
  const log = fs.readFileSync(runtime.logFile, 'utf8');
  check(!log.includes(runtime.launchToken), 'the launch token is not in the log');
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : error}`);
  const file = error?.logFile ?? logFile;
  if (file && fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8'));
  process.exit(1);
});
