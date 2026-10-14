// Builds the compute worker into plain JavaScript under dist/ so production
// runs `node dist/server.js` without a TypeScript loader.
//
// - Worker sources and the TypeScript workspace packages (@openreader/*) are
//   bundled; every npm package stays external and is installed normally, so
//   native addons, runtime-resolved binaries, and packages that load their own
//   files by path (onnxruntime-node, @napi-rs/canvas, ffmpeg-static,
//   pdfjs-dist, pino transports) behave exactly as they do from source.
// - Every `src/**/assets/` directory is copied to the same relative path under
//   dist/. Modules locate them through src/worker-paths.ts, which resolves to
//   src/ from source and to dist/ once bundled.
import { build } from 'esbuild';
import { isBuiltin } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(workerDir, 'src');
const distDir = path.join(workerDir, 'dist');
const workerPathsModule = path.join(srcDir, 'worker-paths.ts');

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Records every bare npm import esbuild actually resolves (type-only imports
// are elided before resolution) together with the file that imports it.
const externalImports = [];
const externalNpmPackages = {
  name: 'external-npm-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (isBuiltin(args.path) || args.path.startsWith('@openreader/')) return undefined;
      externalImports.push({ importer: args.importer, name: packageName(args.path) });
      return { path: args.path, external: true };
    });
  },
};

fs.rmSync(distDir, { recursive: true, force: true });

const result = await build({
  absWorkingDir: workerDir,
  entryPoints: { server: path.join(srcDir, 'server.ts') },
  outdir: distDir,
  // Chunks must sit beside server.js: worker-paths.ts derives the asset root
  // from its own module URL, which is whichever dist/ file it lands in.
  chunkNames: '[name]-[hash]',
  bundle: true,
  // Splitting keeps server.ts's dynamic import of the app graph lazy, so its
  // environment setup runs before external packages such as onnxruntime-node
  // are loaded.
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
  plugins: [externalNpmPackages],
});

const problems = [];

function owningPackageDir(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package.json above ${file}`);
    dir = parent;
  }
  return dir;
}

const runtimeDependenciesByDir = new Map();
function runtimeDependencies(packageDir) {
  if (!runtimeDependenciesByDir.has(packageDir)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    runtimeDependenciesByDir.set(packageDir, new Set(Object.keys(manifest.dependencies ?? {})));
  }
  return runtimeDependenciesByDir.get(packageDir);
}

// Each external import must be a runtime dependency of the package whose source
// imports it (the worker or a bundled @openreader/* package), so a production
// `pnpm deploy` of the worker installs it. The repository's hoisted node-linker
// (.npmrc) places those packages where dist/ resolves them.
const externals = new Set();
for (const { importer, name } of externalImports) {
  externals.add(name);
  const ownerDir = owningPackageDir(importer);
  if (!runtimeDependencies(ownerDir).has(name)) {
    problems.push(
      `${path.relative(workerDir, importer)} imports "${name}", which is not in the dependencies of `
      + `${path.relative(workerDir, path.join(ownerDir, 'package.json'))}.`,
    );
  }
}

// Once bundled, a module's own import.meta.url points at a dist/ file, so a
// file lookup relative to it would silently break. Only worker-paths.ts may
// derive paths from its module location.
const moduleLocation = /\bimport\.meta\.(url|dirname|filename)\b|\b__dirname\b|\b__filename\b/;
for (const input of Object.keys(result.metafile.inputs)) {
  const inputPath = path.resolve(workerDir, input);
  if (inputPath.includes(`${path.sep}node_modules${path.sep}`) || inputPath === workerPathsModule) continue;
  if (moduleLocation.test(fs.readFileSync(inputPath, 'utf8'))) {
    problems.push(`${path.relative(workerDir, inputPath)} derives a path from its module location; use src/worker-paths.ts.`);
  }
}

if (problems.length > 0) {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.error('[compute-worker build] failed:');
  for (const problem of [...new Set(problems)]) console.error(`- ${problem}`);
  process.exit(1);
}

let copiedAssets = 0;
function copyAssetDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.name !== 'assets') {
      copyAssetDirs(fullPath);
      continue;
    }
    fs.cpSync(fullPath, path.join(distDir, path.relative(srcDir, fullPath)), { recursive: true });
    copiedAssets += fs.readdirSync(fullPath, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile()).length;
  }
}
copyAssetDirs(srcDir);

const outputs = Object.keys(result.metafile.outputs).filter((file) => file.endsWith('.js'));
console.info(
  `[compute-worker build] ${outputs.length} JS files, ${copiedAssets} asset files, `
  + `${externals.size} external packages -> ${path.relative(process.cwd(), distDir) || distDir}`,
);
