import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('worker model storage directory', () => {
  let root: string;
  let containerDocstore: boolean;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-platform-'));
    containerDocstore = false;
    vi.resetModules();
    vi.stubEnv('PWD', '');
    // Keep the container fallback independent of the machine running the test.
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => (
      file === '/app/docstore' ? containerDocstore : existsSync(file)
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function directory(...parts: string[]) {
    const dir = path.join(root, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function docstore() {
    // The worker test setup mocks model storage; exercise the real resolver.
    return (await vi.importActual<typeof import('../../src/infrastructure/platform')>(
      '../../src/infrastructure/platform',
    )).DOCSTORE_DIR;
  }

  test('reuses persistent models when pnpm deploy adds a workspace manifest to the bundle', async () => {
    const worker = directory('runtime', 'embedded-compute-worker');
    fs.writeFileSync(path.join(worker, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
    const data = directory('user-data');
    const models = directory('user-data', 'docstore', 'model', 'kokoro-82m');
    fs.writeFileSync(path.join(models, 'existing-model'), 'installed before the update');
    vi.spyOn(process, 'cwd').mockReturnValue(worker);
    vi.stubEnv('PWD', data);

    const resolved = await docstore();

    expect(resolved).toBe(path.join(data, 'docstore'));
    expect(fs.readFileSync(path.join(resolved, 'model', 'kokoro-82m', 'existing-model'), 'utf8'))
      .toBe('installed before the update');
    expect(fs.existsSync(path.join(worker, 'docstore'))).toBe(false);
  });

  test('uses desktop data even when a staged runtime is inside a source checkout', async () => {
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    directory('packages', 'compute-worker', 'src');
    const worker = directory('desktop', 'stage', 'runtime', 'embedded-compute-worker');
    const data = directory('user-data');
    directory('user-data', 'docstore');
    vi.spyOn(process, 'cwd').mockReturnValue(worker);
    vi.stubEnv('PWD', data);

    expect(await docstore()).toBe(path.join(data, 'docstore'));
  });

  test('uses the source workspace when the inherited directory has no docstore', async () => {
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    directory('packages', 'compute-worker', 'src');
    vi.spyOn(process, 'cwd').mockReturnValue(directory('packages', 'compute-worker'));
    vi.stubEnv('PWD', directory('other-directory'));

    expect(await docstore()).toBe(path.join(root, 'docstore'));
  });

  test('uses the Docker volume despite a deployed workspace manifest when PWD is unset', async () => {
    const worker = directory('embedded-compute-worker');
    fs.writeFileSync(path.join(worker, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
    vi.spyOn(process, 'cwd').mockReturnValue(worker);
    containerDocstore = true;

    expect(await docstore()).toBe('/app/docstore');
  });

  test('uses the working directory for a standalone worker without an inherited docstore', async () => {
    const worker = directory('standalone');
    vi.spyOn(process, 'cwd').mockReturnValue(worker);

    expect(await docstore()).toBe(path.join(worker, 'docstore'));
  });
});
