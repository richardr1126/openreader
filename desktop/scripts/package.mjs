#!/usr/bin/env node
// Packages the shell and the staged runtime (scripts/stage.mjs) with
// electron-builder for this machine's platform and architecture: a DMG on macOS,
// an NSIS installer on Windows, and an AppImage and a .deb on Linux. The app
// version is the root package version.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { sourceTreeId } from './source-tree.mjs';

const { Arch, Platform, build } = builder;

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(desktopDir, 'stage', 'runtime', 'app', 'server.js'))) {
  console.error('[package] desktop/stage/runtime is missing: run `pnpm stage` first.');
  process.exit(1);
}
// The runtime carries the bootstrap and worker as they were when staged, so a
// package must not pair this shell with older source.
const stagedTree = fs.existsSync(path.join(desktopDir, 'stage', 'source-tree'))
  ? fs.readFileSync(path.join(desktopDir, 'stage', 'source-tree'), 'utf8').trim()
  : null;
const currentTree = sourceTreeId(repoRoot);
if (currentTree && stagedTree !== currentTree) {
  console.error('[package] desktop/stage/runtime was staged from different source: run `pnpm build` and `pnpm stage` again.');
  process.exit(1);
}

const config = {
  appId: 'dev.richardr.openreader',
  productName: 'OpenReader',
  copyright: 'Copyright © Richard R',
  extraMetadata: { version },
  directories: { output: 'dist' },
  // One name shape for every platform, so a release holds each arch side by side.
  artifactName: 'OpenReader-${version}-${arch}.${ext}',
  files: ['src/**/*', 'package.json'],
  // The runtime runs as separate Node.js processes, so it stays outside the asar.
  extraResources: [{ from: 'stage/runtime', to: 'runtime' }],
  icon: path.join(repoRoot, 'public', 'web-app-manifest-512x512.png'),
  npmRebuild: false,
  publish: null,
  // Opened documents go to the library's upload flow (src/open-documents.mjs).
  // OpenReader claims EPUB but only offers itself for PDF.
  fileAssociations: [
    { ext: 'epub', name: 'EPUB Document', mimeType: 'application/epub+zip', role: 'Viewer', rank: 'Default' },
    { ext: 'pdf', name: 'PDF Document', mimeType: 'application/pdf', role: 'Viewer', rank: 'Alternate' },
  ],
  mac: {
    target: 'dmg',
    category: 'public.app-category.productivity',
    minimumSystemVersion: '12.0',
  },
  win: { target: 'nsis' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    maintainer: 'Richard R <me@richardr.dev>',
  },
};

await build({
  projectDir: desktopDir,
  targets: Platform.current().createTarget(null, Arch[process.arch]),
  config,
});
