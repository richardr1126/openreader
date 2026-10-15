// Identifies the checkout's working tree, tracked and untracked files alike, so
// `package` can refuse a runtime that `stage` assembled from different source.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The git tree id of the working tree, or null outside a git checkout. */
export function sourceTreeId(repoRoot) {
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-stage-index-'));
  const git = (args) => spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: path.join(indexDir, 'index') },
  });
  try {
    for (const args of [['read-tree', 'HEAD'], ['add', '--all']]) {
      if (git(args).status !== 0) return null;
    }
    const tree = git(['write-tree']);
    return tree.status === 0 ? tree.stdout.trim() : null;
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}
