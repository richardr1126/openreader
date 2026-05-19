import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  createSingleflightRunner,
  ensureWhisperArtifacts,
} from '../../src/lib/server/whisper/ensureModel';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test.describe('whisper ensure model helpers', () => {
  test('downloads and verifies artifacts, and repairs checksum mismatch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openreader-whisper-model-test-'));
    const artifactBytes = new TextEncoder().encode('artifact-content-v1');
    const artifactHash = sha256(artifactBytes);
    const artifactPath = 'onnx/encoder_model_int8.onnx';
    const target = path.join(root, artifactPath);

    try {
      // Seed a corrupted file to verify repair behavior.
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array([0, 1, 2, 3]));

      let fetchCount = 0;
      await ensureWhisperArtifacts({
        modelDir: root,
        artifacts: [
          {
            path: artifactPath,
            sha256: artifactHash,
            size: artifactBytes.byteLength,
            url: 'https://example.local/fake-artifact',
          },
        ],
        fetchImpl: async () => {
          fetchCount += 1;
          return new Response(artifactBytes, { status: 200 });
        },
      });

      const repaired = await readFile(target);
      expect(repaired.byteLength).toBe(artifactBytes.byteLength);
      expect(sha256(repaired)).toBe(artifactHash);
      expect(fetchCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('singleflight runner deduplicates concurrent work', async () => {
    let runs = 0;
    const run = createSingleflightRunner(async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'ok';
    });

    const [a, b, c] = await Promise.all([run(), run(), run()]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(c).toBe('ok');
    expect(runs).toBe(1);

    await run();
    expect(runs).toBe(2);
  });
});
