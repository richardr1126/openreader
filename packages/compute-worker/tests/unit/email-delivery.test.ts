import { afterEach, describe, expect, test, vi } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

import { deliverEmail, EmailDeliveryError, renderEmailContent } from '../../src/jobs/email-delivery';

afterEach(() => {
  vi.unstubAllGlobals();
  send.mockReset();
});

describe('email delivery', () => {
  test('escapes token-bearing links in HTML while retaining the plain-text fallback', () => {
    const actionUrl = 'https://reader.example/reset?token=a&next=<unsafe>';
    const rendered = renderEmailContent({
      deliveryId: 'delivery',
      purpose: 'password_reset',
      to: 'reader@example.com',
      senderName: 'OpenReader',
      senderEmail: 'mail@example.com',
      replyTo: null,
      actionUrl,
      expiresAt: Date.UTC(2026, 8, 13, 22),
    });
    expect(rendered.subject).toBe('Reset your OpenReader password');
    expect(rendered.html).toContain('token=a&amp;next=&lt;unsafe&gt;');
    expect(rendered.html).not.toContain('next=<unsafe>');
    expect(rendered.html).toContain('role="presentation"');
    expect(rendered.html).toContain('background:#ef4444');
    expect(rendered.html).toContain('src="cid:openreader-logo"');
    expect(rendered.html).toContain('alt="OpenReader"');
    expect(rendered.html).toContain("font-family:Georgia,'Times New Roman',serif");
    expect(rendered.html).toContain('highlighted word by word.');
    expect(rendered.text).toContain(actionUrl);
  });

  test('uses the delivery id as Resend idempotency key and reports API acceptance', async () => {
    const expiresAt = Date.now() + 60_000;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      apiKey: 're_secret',
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      purpose: 'admin_test',
      to: 'admin@example.com',
      senderName: 'OpenReader',
      senderEmail: 'mail@example.com',
      replyTo: null,
      actionUrl: null,
      expiresAt,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    send.mockResolvedValue({ data: { id: 'resend-message' }, error: null, headers: null });
    const result = await deliverEmail({
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      purpose: 'admin_test',
      envelopeCiphertext: 'encrypted-envelope-content',
      envelopeIv: 'encrypted-iv',
      expiresAt,
    });
    expect(result).toEqual({
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      status: 'accepted',
      resendMessageId: 'resend-message',
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'admin@example.com',
      subject: 'OpenReader test email',
      attachments: [expect.objectContaining({
        content: expect.any(Buffer),
        filename: 'web-app-manifest-192x192.png',
        contentType: 'image/png',
        contentId: 'openreader-logo',
      })],
    }), { idempotencyKey: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31' });
  });

  test('rejects expired envelopes without contacting the broker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(deliverEmail({
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      purpose: 'email_verification',
      envelopeCiphertext: 'encrypted-envelope-content',
      envelopeIv: 'encrypted-iv',
      expiresAt: Date.now() - 1,
    })).rejects.toEqual(expect.objectContaining<Partial<EmailDeliveryError>>({
      code: 'EMAIL_ENVELOPE_EXPIRED', retryable: false,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('preserves Resend retry guidance for transient failures', async () => {
    const expiresAt = Date.now() + 60_000;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      apiKey: 're_secret',
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      purpose: 'admin_test',
      to: 'admin@example.com',
      senderName: 'OpenReader',
      senderEmail: 'mail@example.com',
      replyTo: null,
      actionUrl: null,
      expiresAt,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    send.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 },
      headers: { 'retry-after': '7' },
    });

    await expect(deliverEmail({
      deliveryId: '54f60fb9-e895-4c1c-9968-9d27ebbd9c31',
      purpose: 'admin_test',
      envelopeCiphertext: 'encrypted-envelope-content',
      envelopeIv: 'encrypted-iv',
      expiresAt,
    })).rejects.toEqual(expect.objectContaining<Partial<EmailDeliveryError>>({
      code: 'RESEND_RATE_LIMIT_EXCEEDED',
      retryable: true,
      retryAfterMs: 7_000,
    }));
  });
});
