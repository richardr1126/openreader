import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ send: vi.fn(async (_command: unknown) => ({})) }));
vi.mock('@/lib/server/storage/s3', () => ({ getS3Config: () => ({ prefix: 'test', bucket: 'test' }),
  getS3InternalClient: () => ({ send: mock.send }), isS3Configured: () => true }));
import { writeClonedVoice } from '@/lib/server/tts/cloned-voices';
const voice = { id: 'clone:7e94cb5c-1032-44b8-84ee-8a7a6f99d629', name: 'Narrator', providerRef: 'fish',
  providerType: 'fish-audio' as const, model: 's2.1-pro-free', audio: 'private-reference', transcript: '' };
beforeEach(() => vi.clearAllMocks());
test('encrypts private reference samples with the existing object-storage policy', async () => {
  await writeClonedVoice('alice', voice);
  expect(mock.send.mock.calls[0][0]).toMatchObject({ input: { Bucket: 'test', ServerSideEncryption: 'AES256',
    Key: 'test/cloned_voices_v1/users/alice/7e94cb5c-1032-44b8-84ee-8a7a6f99d629.json' } });
});
test('rejects oversized stored references before object storage writes', async () => {
  await expect(writeClonedVoice('alice', { ...voice, audio: 'x'.repeat(1_040_001) })).rejects.toThrow('size limit');
  expect(mock.send).not.toHaveBeenCalled();
});
