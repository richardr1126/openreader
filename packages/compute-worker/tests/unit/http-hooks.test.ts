import { EventEmitter } from 'node:events';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, test, vi } from 'vitest';

import { registerHttpHooks } from '../../src/api/http-hooks';

type HttpHook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function createHarness() {
  const hooks = new Map<string, HttpHook>();
  const markActivity = vi.fn();
  const onInFlightHttpChanged = vi.fn();
  const app = {
    addHook: (name: string, hook: HttpHook) => {
      hooks.set(name, hook);
    },
    log: { error: vi.fn() },
  } as unknown as FastifyInstance;

  registerHttpHooks({
    app,
    workerToken: 'test-token',
    markActivity,
    onInFlightHttpChanged,
  });

  const response = new EventEmitter();
  const request = {
    headers: { authorization: 'Bearer test-token' },
    id: 'request-1',
    method: 'GET',
    params: {},
    url: '/v1/operations/op-1',
  } as unknown as FastifyRequest;
  const reply = {
    raw: response,
    statusCode: 200,
  } as unknown as FastifyReply;

  return {
    hooks,
    markActivity,
    onInFlightHttpChanged,
    reply,
    request,
    response,
  };
}

describe('compute worker HTTP accounting', () => {
  test('releases an aborted response when the response socket closes', async () => {
    const harness = createHarness();

    await harness.hooks.get('onRequest')?.(harness.request, harness.reply);
    harness.response.emit('close');

    expect(harness.onInFlightHttpChanged.mock.calls.map(([delta]) => delta)).toEqual([1, -1]);
    expect(harness.markActivity).toHaveBeenLastCalledWith('http_completed');
  });

  test('counts a normally completed response only once', async () => {
    const harness = createHarness();

    await harness.hooks.get('onRequest')?.(harness.request, harness.reply);
    await harness.hooks.get('onResponse')?.(harness.request, harness.reply);
    harness.response.emit('close');

    expect(harness.onInFlightHttpChanged.mock.calls.map(([delta]) => delta)).toEqual([1, -1]);
    expect(harness.markActivity.mock.calls.filter(([reason]) => reason === 'http_completed')).toHaveLength(1);
  });
});
