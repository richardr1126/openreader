import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { expect, test, vi } from 'vitest';
import { createArtifactStorage } from '../../src/infrastructure/storage';

test('uploads a file as a stream with its known size and closes it on failure', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'openreader-upload-test-'));
  try {
    const path = join(workDir, 'audio.mp3');
    await writeFile(path, Buffer.alloc(256_000, 7));
    let uploadBody: Readable | null = null;
    const send = vi.fn(async (command) => {
      uploadBody = command.input.Body;
      expect(uploadBody).toBeInstanceOf(Readable);
      expect(command.input.ContentLength).toBe(256_000);
      expect(command.input.ContentType).toBe('audio/mpeg');
      expect(command.input.ServerSideEncryption).toBe('AES256');
      let bytes = 0;
      for await (const chunk of uploadBody!) bytes += chunk.length;
      expect(bytes).toBe(256_000);
    });
    const storage = createArtifactStorage({ prefix: 'test', bucket: 'test', client: { send } as unknown as S3Client });
    await storage.putFile('test/audio.mp3', path, 'audio/mpeg');
    expect((uploadBody as unknown as Readable).destroyed).toBe(true);
    send.mockImplementationOnce(async (command) => {
      uploadBody = command.input.Body;
      throw new Error('upload failed');
    });
    await expect(storage.putFile('test/audio.mp3', path, 'audio/mpeg')).rejects.toThrow('upload failed');
    expect((uploadBody as unknown as Readable).destroyed).toBe(true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
