import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverDir = path.join(root, '.next', 'server');

if (!fs.existsSync(serverDir)) {
  console.error('[bundle-guard] Missing .next/server. Run `pnpm build` first.');
  process.exit(1);
}

const forbidden = [
  'onnxruntime-node',
  '@huggingface/tokenizers',
  '@openreader/compute-worker',
  '/compute-worker/src/compute/',
];

const includeExt = new Set(['.js', '.mjs', '.cjs']);
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!includeExt.has(ext)) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const pattern of forbidden) {
      if (text.includes(pattern)) {
        failures.push({ file: fullPath, pattern });
      }
    }
  }
}

walk(serverDir);

if (failures.length > 0) {
  console.error('[bundle-guard] Forbidden compute deps detected in Next server bundle:');
  for (const failure of failures) {
    console.error(`- ${failure.pattern} in ${path.relative(root, failure.file)}`);
  }
  process.exit(1);
}

console.info('[bundle-guard] OK: no forbidden compute deps in .next/server');
