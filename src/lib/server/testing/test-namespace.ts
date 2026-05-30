import path from 'path';
import { UNCLAIMED_USER_ID } from '@/lib/server/storage/docstore-legacy';
import { ensureSystemUserExists } from '@/db';

const TEST_NAMESPACE_HEADER = 'x-openreader-test-namespace';
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * The test-namespace header is test/CI scaffolding and must never be honored on
 * a real production deployment. It is enabled when `ENABLE_TEST_NAMESPACE=true`
 * (set explicitly by the Playwright web server / CI env) or, for local dev
 * convenience, whenever the build is not a production build.
 *
 * Note: the E2E suite runs against a production build (`pnpm build && pnpm
 * start`), so a `NODE_ENV` check alone is insufficient — CI relies on the
 * explicit flag.
 */
function isTestNamespaceEnabled(): boolean {
  if (process.env.ENABLE_TEST_NAMESPACE?.trim().toLowerCase() === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

export function getOpenReaderTestNamespace(headers: Headers): string | null {
  if (!isTestNamespaceEnabled()) return null;

  const raw = headers.get(TEST_NAMESPACE_HEADER)?.trim();
  if (!raw) return null;

  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe === '.' || safe === '..' || safe.includes('..')) return null;
  if (!SAFE_NAMESPACE_REGEX.test(safe)) return null;

  return safe;
}

export function applyOpenReaderTestNamespacePath(baseDir: string, namespace: string | null): string {
  if (!namespace) return baseDir;

  const resolved = path.resolve(baseDir, namespace);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return baseDir;
  return resolved;
}

export function getUnclaimedUserIdForNamespace(namespace: string | null): string {
  const userId = !namespace ? UNCLAIMED_USER_ID : `${UNCLAIMED_USER_ID}::${namespace}`;
  ensureSystemUserExists(userId);
  return userId;
}

