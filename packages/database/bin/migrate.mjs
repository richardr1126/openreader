#!/usr/bin/env node
import { runMigrations } from '../src/migrate.mjs';

try {
  await runMigrations();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
