import fs from 'fs';
import path from 'path';

function findMonorepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(marker)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveDocstoreDir(): string {
  const repoRoot = findMonorepoRoot(process.cwd());
  if (repoRoot) return path.join(repoRoot, 'docstore');
  return path.join(process.cwd(), 'docstore');
}

export const DOCSTORE_DIR = resolveDocstoreDir();
