import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const forbidden = [
  '@openreader/compute-core',
  '@openreader/compute-worker',
  'compute/core',
  'compute/worker',
  'packages/compute-worker/src',
];
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile() || !/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const pattern of forbidden) {
      if (text.includes(pattern)) failures.push({ file: fullPath, pattern });
    }
  }
}

walk(path.join(root, 'src'));

if (failures.length > 0) {
  console.error('[compute-boundary] Forbidden app-to-worker source coupling detected:');
  for (const failure of failures) {
    console.error(`- ${failure.pattern} in ${path.relative(root, failure.file)}`);
  }
  process.exit(1);
}

console.info('[compute-boundary] OK: app communicates with compute worker through protocol/client only');
