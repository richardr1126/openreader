import { randomUUID } from 'node:crypto';
import { encryptSecret } from '@/lib/server/crypto/secrets';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { ComputeOperation } from '@/lib/server/compute-worker/protocol';
import type { AccountEmailSettings } from '@/lib/server/admin/email-settings';
import { getAccountEmailSettings } from '@/lib/server/admin/email-settings';

export type AccountEmailPurpose = 'email_verification' | 'password_reset' | 'admin_test';

export type EmailDeliveryEnvelope = {
  schemaVersion: 1;
  deliveryId: string;
  purpose: AccountEmailPurpose;
  recipient: string;
  actionUrl: string | null;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
  expiresAt: number;
  allowWhenDisabled: boolean;
};

function assertConfigured(settings: AccountEmailSettings, allowWhenDisabled: boolean): void {
  if (!allowWhenDisabled && !settings.enabled) throw new Error('ACCOUNT_EMAILS_DISABLED');
  if (!settings.apiKey || !settings.senderEmail || !settings.senderName) {
    throw new Error('ACCOUNT_EMAILS_NOT_CONFIGURED');
  }
}

export async function enqueueAccountEmail(input: {
  purpose: AccountEmailPurpose;
  recipient: string;
  actionUrl?: string | null;
  allowWhenDisabled?: boolean;
  deliveryId?: string;
  expiresAt?: number;
}): Promise<ComputeOperation> {
  const settings = await getAccountEmailSettings();
  const allowWhenDisabled = input.allowWhenDisabled === true;
  assertConfigured(settings, allowWhenDisabled);
  const deliveryId = input.deliveryId ?? randomUUID();
  const expiresAt = input.expiresAt ?? Date.now() + 60 * 60 * 1000;
  const envelope: EmailDeliveryEnvelope = {
    schemaVersion: 1,
    deliveryId,
    purpose: input.purpose,
    recipient: input.recipient.trim().toLowerCase(),
    actionUrl: input.actionUrl ?? null,
    senderName: settings.senderName,
    senderEmail: settings.senderEmail,
    replyTo: settings.replyTo,
    expiresAt,
    allowWhenDisabled,
  };
  const encrypted = encryptSecret(JSON.stringify(envelope));
  return getComputeWorkerClient().createEmailDeliveryOperation({
    deliveryId,
    purpose: input.purpose,
    envelopeCiphertext: encrypted.ciphertext,
    envelopeIv: encrypted.iv,
    expiresAt,
  });
}
