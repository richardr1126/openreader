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

// Ensure AUTH_SECRET and BASE_URL are set so Better Auth CLI can evaluate the config.
const env = { ...process.env };
if (!env.AUTH_SECRET) env.AUTH_SECRET = 'generate-placeholder-secret-value-32chars!!';
if (!env.BASE_URL) env.BASE_URL = 'http://localhost:3003';

const extraArgs = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Step 1: Generate Better Auth schema files (one per dialect).
//
// The Better Auth CLI reads our auth config and produces a Drizzle schema file
// matching the adapter in use. We run it twice:
//   - Without POSTGRES_URL  → SQLite schema
//   - With    POSTGRES_URL  → Postgres schema
//
// These files are checked in and should NOT be hand-edited.
// ---------------------------------------------------------------------------
console.log('\n--- Generating Better Auth schema (SQLite) ---');
{
  const envSqlite = { ...env };
  delete envSqlite.POSTGRES_URL; // force SQLite adapter
  const result = spawnSync('npx', [
    '@better-auth/cli', 'generate',
    '--output', 'src/db/schema_auth_sqlite.ts',
    '--yes',
  ], { stdio: 'inherit', env: envSqlite });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

console.log('\n--- Generating Better Auth schema (Postgres) ---');
{
  const envPg = { ...env };
  // A placeholder URL is enough – the CLI doesn't connect, it just reads the config.
  if (!envPg.POSTGRES_URL) {
    envPg.POSTGRES_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
  }
  const result = spawnSync('npx', [
    '@better-auth/cli', 'generate',
    '--output', 'src/db/schema_auth_postgres.ts',
    '--yes',
  ], { stdio: 'inherit', env: envPg });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// Step 2: Generate Drizzle migrations for both dialects.
// ---------------------------------------------------------------------------
for (const configFile of ['drizzle.config.sqlite.ts', 'drizzle.config.pg.ts']) {
  console.log(`\n--- Drizzle generate (${configFile}) ---`);
  const result = spawnSync('drizzle-kit', ['generate', '--config', configFile, ...extraArgs], {
    stdio: 'inherit',
    env,
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
