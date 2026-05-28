#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'src', 'app', 'api');

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
      continue;
    }
    if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
  return files;
}

function findViolations(source) {
  const violations = [];
  const catchWithDirectJson500 =
    /catch\s*\(\s*error\s*\)\s*\{[\s\S]{0,1200}?NextResponse\.json\s*\(\s*\{\s*error:[\s\S]{0,240}status:\s*500/g;
  let match;
  while ((match = catchWithDirectJson500.exec(source)) !== null) {
    const index = match.index;
    const line = source.slice(0, index).split('\n').length;
    violations.push(line);
  }
  return violations;
}

const files = await walk(API_DIR);
const failures = [];
for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const lines = findViolations(source);
  if (lines.length > 0) {
    failures.push({ file, lines });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    for (const line of failure.lines) {
      console.error(`${path.relative(ROOT, failure.file)}:${line} direct NextResponse.json({ error }) in catch`);
    }
  }
  process.exit(1);
}

console.log('Route error response check passed.');
