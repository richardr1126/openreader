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
  // 1. Try to find the monorepo root (works in local development)
  const repoRoot = findMonorepoRoot(process.cwd());
  if (repoRoot) return path.join(repoRoot, 'docstore');

  // 2. In a containerized environment, the parent bootstrap process runs in /app
  // and the child process inherits process.env.PWD = '/app'.
  if (process.env.PWD) {
    const pwdDocstore = path.join(process.env.PWD, 'docstore');
    if (fs.existsSync(pwdDocstore)) return pwdDocstore;
  }

  // 3. Fallback to the standard container app docstore path if it exists
  if (fs.existsSync('/app/docstore')) {
    return '/app/docstore';
  }

  // 4. Fallback to the process cwd docstore
  return path.join(process.cwd(), 'docstore');
}

export const DOCSTORE_DIR = resolveDocstoreDir();
