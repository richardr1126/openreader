#!/usr/bin/env node
// Collects the licence texts of what OpenReader ships into
// public/acknowledgements.json, which Settings → About renders as its
// Acknowledgements list.
//
// Two sources:
// - npm production dependencies of every workspace package (the app, the
//   compute worker and bootstrap), walked from `pnpm list --prod`. The texts
//   are read from each installed package's own LICENSE/COPYING/NOTICE files.
// - scripts/acknowledgements/manifest.json: shipped components that are not
//   npm dependencies (the Docker image's binaries and the runtime-downloaded
//   models). Add a shipped binary or model there, one line per component.
//
// Identical texts are stored once, so a shared licence such as Apache-2.0 keeps
// one copy with the attribution on each component. Platform-specific native
// packages (`-darwin-arm64`, `-linux-x64`, …) are folded into one
// `-<platform>` entry so the output does not depend on the machine it ran on.
//
// Re-run after dependencies change (`pnpm install` first, with build scripts
// enabled so ffmpeg-static has fetched its binary and notices):
//   pnpm acknowledgements   (node scripts/collect-acknowledgements.mjs)
// `--check` exits non-zero when the committed output is stale.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts/acknowledgements/manifest.json');
// Served as a static asset and fetched by the page that shows it, so the texts
// stay out of the server bundle and out of every other page's JavaScript.
const OUTPUT = path.join(ROOT, 'public/acknowledgements.json');
const CHECK = process.argv.includes('--check');

const LICENSE_FILE = /^(licen[cs]e|copying|unlicen[cs]e)([.-].*)?$/i;
const NOTICE_FILE = /^notice([.-].*)?$/i;
const PLATFORM_SUFFIX = /(?<=[-/])(darwin|linux|linuxmusl|win32|freebsd|android|openbsd|netbsd|sunos|aix|wasm32)(-(x64|arm64|arm|ia32|x86|ppc64|s390x|riscv64|loong64|mips64el|gnu|musl|gnueabihf|msvc|eabi|universal))*$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

// A notice line, not a wrapped sentence of licence prose ("copyright notice
// that is…", Apache's "(c) You must retain…"): capitalised, or "(c)" + a year.
const COPYRIGHT_LINE = /^\s*(Copyright\b|COPYRIGHT\b|©|\([cC]\)\s*\d)/;
// Placeholders and the FSF's own notice belong to the licence text itself.
const LICENCE_OWN_LINE = /Free Software Foundation|\[yyyy\]|<year>|<name of author>/;
const APACHE_TEMPLATE_LINE = '   Copyright [yyyy] [name of copyright owner]';

/**
 * Moves a licence's own copyright lines out of its text, so projects under the
 * same licence share one copy and keep their attribution beside their name.
 */
export function splitCopyright(text) {
  const copyright = [];
  let inApacheAppendix = false;
  const lines = normalizeText(text).split('\n').flatMap((line) => {
    if (/APPENDIX: How to apply the Apache License/.test(line)) inApacheAppendix = true;
    if (!COPYRIGHT_LINE.test(line) || LICENCE_OWN_LINE.test(line)) return [line];
    copyright.push(line.trim());
    return inApacheAppendix ? [APACHE_TEMPLATE_LINE] : [];
  });
  return { body: normalizeText(lines.join('\n').replace(/\n{3,}/g, '\n\n')), copyright };
}

const texts = new Map();
/** Stores a licence text once and returns its id plus the copyright lines taken out of it. */
function addText(text) {
  const { body, copyright } = splitCopyright(text);
  const id = createHash('sha256').update(body).digest('hex').slice(0, 12);
  texts.set(id, body);
  return { id, copyright };
}

/** name@version → installed directory, for the hoisted linker this repo uses. */
function indexInstalledPackages() {
  const index = new Map();
  const visit = (modulesDir) => {
    if (!existsSync(modulesDir)) return;
    for (const entry of readdirSync(modulesDir)) {
      if (entry.startsWith('.')) continue;
      const entryPath = path.join(modulesDir, entry);
      const packageDirs = entry.startsWith('@')
        ? readdirSync(entryPath).map((child) => path.join(entryPath, child))
        : [entryPath];
      for (const dir of packageDirs) {
        const manifestPath = path.join(dir, 'package.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const { name, version } = JSON.parse(readFileSync(manifestPath, 'utf8'));
          // Also keyed by the directory name, which is the alias for `npm:` overrides.
          const alias = path.relative(modulesDir, dir).split(path.sep).join('/');
          for (const key of [`${name}@${version}`, `${alias}@${version}`]) {
            if (!index.has(key)) index.set(key, dir);
          }
        } catch {
          // A package.json fixture inside a package is not a package.
        }
        visit(path.join(dir, 'node_modules'));
      }
    }
  };
  visit(path.join(ROOT, 'node_modules'));
  for (const workspace of readdirSync(path.join(ROOT, 'packages'))) {
    visit(path.join(ROOT, 'packages', workspace, 'node_modules'));
  }
  return index;
}

function licenseFilesIn(dir) {
  const files = readdirSync(dir).filter((file) => (
    (LICENSE_FILE.test(file) || NOTICE_FILE.test(file)) && statSync(path.join(dir, file)).isFile()
  ));
  // Licences before notices, then by name, so the order is stable.
  return files.sort((a, b) => (
    Number(NOTICE_FILE.test(a)) - Number(NOTICE_FILE.test(b)) || a.localeCompare(b)
  ));
}

function authorName(author) {
  if (!author) return undefined;
  if (typeof author === 'string') return author.replace(/\s*[<(].*$/, '').trim() || undefined;
  return typeof author.name === 'string' ? author.name : undefined;
}

function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === 'string') return license;
  if (license?.type) return license.type;
  if (Array.isArray(licenses) && licenses.length > 0) {
    const types = licenses.map((entry) => entry.type ?? entry).filter(Boolean);
    return types.length > 1 ? `(${types.join(' OR ')})` : types[0];
  }
  return 'UNKNOWN';
}

function homepageOf(manifest) {
  if (typeof manifest.homepage === 'string') return manifest.homepage;
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (repository) {
    return repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
      .replace(/^github:/, 'https://github.com/');
  }
  return `https://www.npmjs.com/package/${manifest.name}`;
}

/**
 * Production packages reachable from the workspace packages. pnpm lists a
 * package's optional peers as its dependencies once something installs them
 * (better-auth's optional `vitest` peer pulls in the whole test toolchain), so
 * the walk skips optional-peer edges: whatever actually provides such a peer
 * reaches it through its own dependency edge.
 */
function reachableProductionPackages(installed) {
  const output = execFileSync('pnpm', ['list', '--prod', '--json', '--depth', 'Infinity', '--recursive'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const importers = JSON.parse(output);
  // pnpm may print a repeated subtree once, so gather each package's children from every occurrence.
  const children = new Map();
  const gather = (dependencies) => {
    for (const [name, node] of Object.entries(dependencies ?? {})) {
      const key = `${name}@${node.version}`;
      const known = children.get(key) ?? new Map();
      for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
        known.set(childName, `${childName}@${child.version}`);
      }
      children.set(key, known);
      gather(node.dependencies);
    }
  };
  for (const importer of importers) gather(importer.dependencies);

  const reached = new Map();
  const walk = (key, optional = false) => {
    if (reached.has(key) || key.startsWith('@openreader/') || key.includes('@link:')) return;
    const dir = installed.get(key);
    // Optional dependencies for other platforms are listed but never installed.
    if (!dir && optional) return;
    if (!dir) fail(`Cannot find the installed ${key}. Run pnpm install first.`);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    reached.set(key, { dir, manifest });
    for (const [childName, childKey] of children.get(key) ?? []) {
      if (manifest.peerDependenciesMeta?.[childName]?.optional) continue;
      walk(childKey, Boolean(manifest.optionalDependencies?.[childName]));
    }
  };
  for (const importer of importers) {
    for (const [name, node] of Object.entries(importer.dependencies ?? {})) walk(`${name}@${node.version}`);
  }
  return [...reached.values()];
}

function collectNpm() {
  const installed = indexInstalledPackages();
  const components = new Map();
  const missing = new Set();

  for (const { dir, manifest } of reachableProductionPackages(installed)) {
    const license = licenseOf(manifest);
    const name = manifest.name.replace(PLATFORM_SUFFIX, '<platform>');
    const key = `${name}|${license}`;
    const component = components.get(key) ?? {
      name,
      versions: new Set(),
      kind: 'npm',
      license,
      ...(manifest.description ? { role: manifest.description } : {}),
      url: homepageOf(manifest),
      author: authorName(manifest.author),
      copyright: new Set(),
      textIds: new Set(),
    };
    component.versions.add(manifest.version);
    for (const file of licenseFilesIn(dir)) {
      const text = addText(readFileSync(path.join(dir, file), 'utf8'));
      component.textIds.add(text.id);
      for (const line of text.copyright) component.copyright.add(line);
    }
    components.set(key, component);
  }

  const result = [...components.values()].map(({ author, versions, copyright, textIds, ...component }) => {
    if (textIds.size === 0) missing.add(component.name);
    return {
      ...component,
      versions: [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      ...(copyright.size === 0 && author ? { notice: `By ${author}.` } : {}),
      copyright: [...copyright],
      textIds: [...textIds],
    };
  });
  return { components: result, missing: [...missing].sort() };
}

function dockerImageVersion(image) {
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const escaped = image.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = dockerfile.match(new RegExp(`^FROM\\s+${escaped}:(\\S+)`, 'm'));
  if (!match) fail(`The Dockerfile has no FROM ${image}:<tag> line for the manifest entry.`);
  return match[1];
}

function collectManifest() {
  const { components } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  return components.map((entry) => {
    const added = entry.texts.map((file) => {
      const filePath = path.join(ROOT, file);
      if (!existsSync(filePath)) fail(`${entry.name}: ${file} is missing. Run pnpm install first.`);
      return addText(readFileSync(filePath, 'utf8'));
    });
    const version = entry.version ?? (entry.dockerImage ? dockerImageVersion(entry.dockerImage) : undefined);
    return {
      name: entry.name,
      versions: version ? [version] : [],
      kind: entry.kind,
      license: entry.license,
      role: entry.role,
      ...(entry.notice ? { notice: entry.notice } : {}),
      url: entry.url,
      copyright: [...new Set(added.flatMap((text) => text.copyright))],
      textIds: [...new Set(added.map((text) => text.id))],
    };
  });
}

function main() {
  const manifestComponents = collectManifest();
  const npm = collectNpm();
  const byName = (a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license);
  const result = {
    generatedBy: 'scripts/collect-acknowledgements.mjs',
    components: [...manifestComponents, ...npm.components.sort(byName)],
    texts: Object.fromEntries([...texts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;

  if (npm.missing.length > 0) {
    console.warn(`No licence file in the published package (credited by name and licence only): ${npm.missing.join(', ')}`);
  }
  if (CHECK) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== serialized) fail(`${path.relative(ROOT, OUTPUT)} is stale. Run node scripts/collect-acknowledgements.mjs.`);
    console.log('Acknowledgements are up to date.');
  } else {
    writeFileSync(OUTPUT, serialized);
    console.log(`Wrote ${result.components.length} components and ${texts.size} licence texts to ${path.relative(ROOT, OUTPUT)}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
