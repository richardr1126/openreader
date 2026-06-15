import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Guards Phase 2 of the data-storage refactor: all user state now lives in
// server-backed storage and is read through React Query. No Dexie/RxDB runtime
// code, dependencies, or migration UI may return to the codebase.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Matches runtime references to the legacy persistence stack. We intentionally
// do NOT match the single sanctioned legacy-cleanup site (`openreader-db`),
// which is allowed to keep deleting the old database on startup.
const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'dexie import', regex: /\bfrom\s+['"]dexie(?:\/[^'"]*)?['"]/i },
  { label: 'dexie require', regex: /require\(\s*['"]dexie(?:\/[^'"]*)?['"]\s*\)/i },
  { label: 'rxdb import', regex: /\bfrom\s+['"]rxdb(?:\/[^'"]*)?['"]/i },
  { label: 'rxdb require', regex: /require\(\s*['"]rxdb(?:\/[^'"]*)?['"]\s*\)/i },
  { label: 'Dexie class reference', regex: /\bnew\s+Dexie\b/ },
  { label: 'migration modal test id', regex: /migration-(?:modal|skip-button)/ },
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

describe('no Dexie/RxDB runtime references', () => {
  const files = collectSourceFiles(SRC_ROOT);

  test('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('src/ contains no Dexie/RxDB runtime imports or migration UI', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(contents)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('package.json does not depend on dexie or rxdb', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(deps)).not.toContain('dexie');
    expect(Object.keys(deps)).not.toContain('rxdb');
  });
});
