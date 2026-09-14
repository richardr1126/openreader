import { NextRequest, NextResponse } from 'next/server';
import { decryptSecret } from '@/lib/server/crypto/secrets';
import { getAccountEmailSettings } from '@/lib/server/admin/email-settings';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import type { EmailDeliveryEnvelope } from '@/lib/server/email/delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };

function error(status: number, code: string): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth === 'unconfigured') return error(503, 'EMAIL_BROKER_UNAVAILABLE');
  if (auth !== 'authorized') return error(401, 'BROKER_UNAUTHORIZED');
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return error(400, 'EMAIL_ENVELOPE_INVALID');
  }
  if (typeof body.deliveryId !== 'string' || typeof body.envelopeCiphertext !== 'string'
    || typeof body.envelopeIv !== 'string' || typeof body.expiresAt !== 'number') {
    return error(400, 'EMAIL_ENVELOPE_INVALID');
  }
  let envelope: EmailDeliveryEnvelope;
  try {
    envelope = JSON.parse(decryptSecret(body.envelopeCiphertext, body.envelopeIv)) as EmailDeliveryEnvelope;
  } catch {
    return error(400, 'EMAIL_ENVELOPE_INVALID');
  }
  if (envelope.schemaVersion !== 1 || envelope.deliveryId !== body.deliveryId
    || envelope.expiresAt !== body.expiresAt || envelope.purpose !== body.purpose
    || Date.now() >= envelope.expiresAt) {
    return error(410, 'EMAIL_ENVELOPE_EXPIRED_OR_INVALID');
  }
  const settings = await getAccountEmailSettings();
  if (!envelope.allowWhenDisabled && !settings.enabled) return error(409, 'ACCOUNT_EMAILS_DISABLED');
  if (!settings.apiKey) return error(409, 'ACCOUNT_EMAILS_NOT_CONFIGURED');
  return NextResponse.json({
    apiKey: settings.apiKey,
    deliveryId: envelope.deliveryId,
    purpose: envelope.purpose,
    to: envelope.recipient,
    senderName: envelope.senderName,
    senderEmail: envelope.senderEmail,
    replyTo: envelope.replyTo,
    actionUrl: envelope.actionUrl,
    expiresAt: envelope.expiresAt,
  }, { headers: NO_STORE });
}
