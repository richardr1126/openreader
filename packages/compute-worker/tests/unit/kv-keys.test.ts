import { describe, expect, test, vi } from 'vitest';
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { listKvKeys } from '../../src/infrastructure/kv-keys';

function setup(messages: Array<{ key: string; operation?: string }> = [], fail = false) {
  const remove = vi.fn(async () => true);
  const close = vi.fn(async () => undefined);
  const consume = vi.fn(async () => ({
    close,
    async *[Symbol.asyncIterator]() {
      for (const [index, message] of messages.entries()) yield {
        subject: `$KV.compute_state.${message.key}`,
        headers: { get: () => message.operation },
        info: { pending: messages.length - index - 1 },
      };
    },
  }));
  const input = {
    js: { consumers: { get: vi.fn(async () => {
      if (fail) throw new Error('disconnected');
      return { info: async () => ({ num_pending: messages.length }), consume };
    }) } } as unknown as JetStreamClient,
    jsm: { consumers: { add: vi.fn(), delete: remove } } as unknown as JetStreamManager,
    bucket: 'compute_state', filter: 'op_state.*',
  };
  return { input, remove, close, consume };
}

describe('bounded KV scan consumers', () => {
  test('deletes every empty scan consumer immediately', async () => {
    const { input, remove, consume } = setup();
    for (let index = 0; index < 125; index++) {
      for await (const _key of listKvKeys(input)) { /* empty */ }
    }
    expect(remove).toHaveBeenCalledTimes(125);
    expect(consume).not.toHaveBeenCalled();
  });
  test('closes and deletes nonempty scans, omitting deleted keys', async () => {
    const { input, remove, close } = setup([{ key: 'op_state.live' }, { key: 'op_state.deleted', operation: 'DEL' }]);
    const keys = [];
    for await (const key of listKvKeys(input)) keys.push(key);
    expect(keys).toEqual(['op_state.live']);
    expect(close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
  test('deletes the consumer when setup fails or a caller stops early', async () => {
    const failed = setup([], true);
    await expect(async () => { for await (const _key of listKvKeys(failed.input)) { /* empty */ } }).rejects.toThrow('disconnected');
    expect(failed.remove).toHaveBeenCalledOnce();
    const early = setup([{ key: 'op_state.one' }, { key: 'op_state.two' }]);
    for await (const _key of listKvKeys(early.input)) break;
    expect(early.close).toHaveBeenCalledOnce();
    expect(early.remove).toHaveBeenCalledOnce();
  });
});
