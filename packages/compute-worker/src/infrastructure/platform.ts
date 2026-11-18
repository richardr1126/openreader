import fs from 'fs';
import path from 'path';

function findMonorepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(marker)) {
      // pnpm deploy writes this marker too. Stop at that package boundary so
      // a staged bundle cannot discover an enclosing source checkout.
      return fs.existsSync(path.join(current, 'packages', 'compute-worker', 'src')) ? current : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveDocstoreDir(): string {
  // A source worker belongs to its checkout even if a task runner inherited
  // PWD from another checkout. Deployed package boundaries are excluded above.
  const repoRoot = findMonorepoRoot(process.cwd());
  if (repoRoot) return path.join(repoRoot, 'docstore');

  // Bootstrap preserves the launcher's PWD: the desktop data directory or /app
  // in Docker. Deployed workers reuse its existing persistent docstore.
  if (process.env.PWD) {
    const pwdDocstore = path.join(process.env.PWD, 'docstore');
    if (fs.existsSync(pwdDocstore)) return pwdDocstore;
  }

  // Fallback to the standard container app docstore path if it exists.
  if (fs.existsSync('/app/docstore')) {
    return '/app/docstore';
  }

  // A standalone worker keeps its data beside its working directory.
  return path.join(process.cwd(), 'docstore');
}

export const DOCSTORE_DIR = resolveDocstoreDir();
