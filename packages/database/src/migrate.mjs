import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFiles(cwd) {
  const envPath = path.join(cwd, '.env');
  const envLocalPath = path.join(cwd, '.env.local');

  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  if (fs.existsSync(envLocalPath)) dotenv.config({ path: envLocalPath, override: true });
}

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

export async function runMigrations({ cwd = process.cwd(), env = process.env } = {}) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  loadEnvFiles(workspaceRoot);

  if (env.POSTGRES_URL?.trim()) {
    const [{ drizzle }, { migrate }, { Pool }] = await Promise.all([
      import('drizzle-orm/node-postgres'),
      import('drizzle-orm/node-postgres/migrator'),
      import('pg'),
    ]);
    const pool = new Pool({ connectionString: env.POSTGRES_URL });
    try {
      await migrate(drizzle(pool), {
        migrationsFolder: path.join(packageDir, 'migrations', 'postgres'),
      });
    } finally {
      await pool.end();
    }
    return;
  }

  const dbPath = path.join(workspaceRoot, 'docstore', 'sqlite3.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const [{ drizzle }, { migrate }, { default: BetterSqlite3 }] = await Promise.all([
    import('drizzle-orm/better-sqlite3'),
    import('drizzle-orm/better-sqlite3/migrator'),
    import('better-sqlite3'),
  ]);
  const sqlite = new BetterSqlite3(dbPath);
  try {
    migrate(drizzle(sqlite), {
      migrationsFolder: path.join(packageDir, 'migrations', 'sqlite'),
    });
  } finally {
    sqlite.close();
  }
}

