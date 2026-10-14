import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only worker module allowed to derive a path from its own location. From
// source it lives in src/; the build bundles it into a file directly under
// dist/ and copies every src/**/assets/** directory to the same relative path,
// so a path resolved here is valid both under tsx and from the built output.
const WORKER_MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function resolveWorkerPath(...segments: string[]): string {
  return path.join(WORKER_MODULE_ROOT, ...segments);
}
