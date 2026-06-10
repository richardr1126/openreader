import { describe, expect, test } from 'vitest';
import { encodeSseFrame, parseSseEventId, parseSsePayload } from '../../src/control-plane/sse';

describe('sse codec', () => {
  test('encodes event id and payload and decodes both reliably', () => {
    const frame = encodeSseFrame({
      id: 42,
      event: 'snapshot',
      data: { ok: true, opId: 'op-1' },
    });

    expect(frame).toContain('event: snapshot');
    expect(parseSseEventId(frame)).toBe(42);
    expect(parseSsePayload(frame)).toBe('{"ok":true,"opId":"op-1"}');
  });

  test('supports multiline data payload', () => {
    const frame = encodeSseFrame({
      id: 5,
      data: 'line1\nline2',
    });

    expect(parseSseEventId(frame)).toBe(5);
    expect(parseSsePayload(frame)).toBe('line1\nline2');
  });

  test('emits a retry directive when provided', () => {
    const frame = encodeSseFrame({ retry: 120_000 });
    expect(frame).toContain('retry: 120000');
  });

  test('omits retry when not finite and floors fractional values', () => {
    expect(encodeSseFrame({ retry: Number.NaN })).not.toContain('retry:');
    expect(encodeSseFrame({ retry: 1500.9 })).toContain('retry: 1500');
  });
});
