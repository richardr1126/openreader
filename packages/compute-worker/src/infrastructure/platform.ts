import fs from 'fs';
import path from 'path';

function findMonorepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    // pnpm deploy writes this marker too; only the source workspace has the
    // worker source package beneath it.
    if (fs.existsSync(marker) && fs.existsSync(path.join(current, 'packages', 'compute-worker', 'src'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveDocstoreDir(): string {
  // Bootstrap preserves the launcher's PWD: the desktop data directory or /app
  // in Docker. Prefer its existing docstore over package metadata: pnpm deploy
  // also writes pnpm-workspace.yaml inside the bundled, read-only worker.
  if (process.env.PWD) {
    const pwdDocstore = path.join(process.env.PWD, 'docstore');
    if (fs.existsSync(pwdDocstore)) return pwdDocstore;
  }

  // Local development can start from any package in the source workspace.
  const repoRoot = findMonorepoRoot(process.cwd());
  if (repoRoot) return path.join(repoRoot, 'docstore');

  // Fallback to the standard container app docstore path if it exists.
  if (fs.existsSync('/app/docstore')) {
    return '/app/docstore';
  }

  // A standalone worker keeps its data beside its working directory.
  return path.join(process.cwd(), 'docstore');
}

export const DOCSTORE_DIR = resolveDocstoreDir();
