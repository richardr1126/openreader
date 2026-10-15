import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// installProfile shapes presentation only. It must never take part in an
// authorization decision, so it may not appear in API routes, auth code or
// middleware. The desktop exchange route authorizes with its launch token.
export const GUARDED_PATHS = ['src/app/api', 'src/lib/server/auth', 'src/middleware.ts'];
const PATTERN = /install[-_]?profile/i;
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

function collect(target, files) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SOURCE_FILE.test(target)) files.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    collect(path.join(target, entry.name), files);
  }
}

export function findInstallProfileViolations(root) {
  const files = [];
  for (const guarded of GUARDED_PATHS) collect(path.join(root, guarded), files);
  const violations = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (PATTERN.test(line)) violations.push({ file: path.relative(root, file), line: index + 1 });
    });
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findInstallProfileViolations(process.cwd());
  if (violations.length > 0) {
    console.error('[install-profile] installProfile is presentation only; remove it from authorization code:');
    for (const violation of violations) console.error(`- ${violation.file}:${violation.line}`);
    process.exit(1);
  }
  console.info('[install-profile] OK: no API route, auth module or middleware reads installProfile');
}
