import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import * as dotenv from 'dotenv';

function loadEnvFiles() {
  // Approximate Next.js behavior enough for server-side scripts.
  // Load .env first, then .env.local (local overrides).
  const cwd = process.cwd();
  const envPath = path.join(cwd, '.env');
  const envLocalPath = path.join(cwd, '.env.local');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
  }
}

loadEnvFiles();

const extraArgs = process.argv.slice(2);

const hasConfigArg = extraArgs.includes('--config');
const configFile = process.env.POSTGRES_URL ? 'drizzle.config.pg.ts' : 'drizzle.config.sqlite.ts';
const configArgs = hasConfigArg ? [] : ['--config', configFile];

// Ensure the docstore directory exists for SQLite migrations.
// drizzle-kit opens the database file directly and will fail if the parent
// directory is missing (e.g. in a fresh CI checkout).
if (!process.env.POSTGRES_URL) {
  const dbDir = path.join(process.cwd(), 'docstore');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

function resolveDrizzleKitBin() {
  const binName = process.platform === 'win32' ? 'drizzle-kit.cmd' : 'drizzle-kit';
  const localBin = path.join(process.cwd(), 'node_modules', '.bin', binName);
  if (fs.existsSync(localBin)) return localBin;
  return 'drizzle-kit';
}

const result = spawnSync(resolveDrizzleKitBin(), ['migrate', ...configArgs, ...extraArgs], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
