import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import { getEmailExecutionBrokerConfig } from '../infrastructure/credential-broker-config';
import type { EmailDeliveryJobRequest, EmailDeliveryJobResult } from '../operations/contracts';

type EmailExecution = {
  apiKey: string;
  deliveryId: string;
  purpose: EmailDeliveryJobRequest['purpose'];
  to: string;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
  actionUrl: string | null;
  expiresAt: number;
};

const EMAIL_LOGO_FILENAME = 'web-app-manifest-192x192.png';
const EMAIL_LOGO_CONTENT_ID = 'openreader-logo';

function resolveEmailLogoPath(): string {
  const candidates = [
    path.join(process.cwd(), 'public', EMAIL_LOGO_FILENAME),
    fileURLToPath(new URL(`../../../../public/${EMAIL_LOGO_FILENAME}`, import.meta.url)),
  ];
  const logoPath = candidates.find((candidate) => existsSync(candidate));
  if (!logoPath) throw new EmailDeliveryError('EMAIL_LOGO_UNAVAILABLE', false);
  return logoPath;
}

export class EmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'EmailDeliveryError';
  }
}

function parseRetryAfter(headers: Record<string, string> | null): number | undefined {
  if (!headers) return undefined;
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return undefined;
  return Math.min(Math.ceil(delay), 60_000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

export function renderEmailContent(execution: Omit<EmailExecution, 'apiKey'>): { subject: string; html: string; text: string } {
  const details = execution.purpose === 'email_verification'
    ? { subject: 'Verify your OpenReader email', eyebrow: 'ACCOUNT SETUP', heading: 'Verify your email', action: 'Verify email', intro: 'Confirm this email address to finish setting up your OpenReader account.', preheader: 'One quick step, then your reading space is ready.' }
    : execution.purpose === 'password_reset'
      ? { subject: 'Reset your OpenReader password', eyebrow: 'ACCOUNT SECURITY', heading: 'Reset your password', action: 'Reset password', intro: 'Use this secure link to choose a new OpenReader password.', preheader: 'A secure password reset was requested for your OpenReader account.' }
      : { subject: 'OpenReader test email', eyebrow: 'DELIVERY TEST', heading: 'Your reading room is connected.', action: '', intro: 'Resend accepted this account-email configuration test. Verification and recovery messages are ready to leave the shelf.', preheader: 'OpenReader account email delivery is configured.' };
  const expiry = new Date(execution.expiresAt).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
  const safeUrl = execution.actionUrl ? escapeHtml(execution.actionUrl) : null;
  const actionHtml = safeUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 24px"><tr><td style="border-radius:10px;background:#ef4444"><a href="${safeUrl}" style="display:inline-block;padding:13px 21px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;line-height:20px;text-decoration:none">${details.action}&nbsp;&nbsp;→</a></td></tr></table><p style="margin:0;color:#718096;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:19px">If the button does not work, copy and paste this address:</p><p style="margin:5px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:19px;word-break:break-all"><a href="${safeUrl}" style="color:#dc2626;text-decoration:underline">${safeUrl}</a></p>`
    : '';
  const securityNote = safeUrl
    ? `This link expires at ${escapeHtml(expiry)}. If you did not request it, you can safely ignore this email.`
    : 'This test was requested from the OpenReader administration panel.';
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${details.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f7fafc;color:#2d3748">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${details.preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f7fafc">
    <tr>
      <td align="center" style="padding:30px 14px 38px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:580px">
          <tr>
            <td style="padding:0 5px 18px">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;border-radius:9px;background:#ef4444;box-shadow:0 5px 14px rgba(239,68,68,.22)"><img src="cid:${EMAIL_LOGO_CONTENT_ID}" width="34" height="34" alt="OpenReader" style="display:block;width:34px;height:34px;border:0;border-radius:9px"></td>
                  <td style="padding-left:10px">
                    <div style="color:#2d3748;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:750;letter-spacing:-.2px">OpenReader</div>
                    <div style="padding-top:3px;color:#718096;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:8px;font-weight:700;letter-spacing:1.5px">READ · LISTEN · FOLLOW</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="overflow:hidden;border:1px solid #e2e8f0;border-radius:18px;background:#ffffff;box-shadow:0 18px 50px rgba(45,55,72,.08)">
              <div style="height:4px;background:#ef4444;font-size:0;line-height:0">&nbsp;</div>
              <div style="padding:38px 40px 36px">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px">
                  <tr>
                    <td style="border:1px solid #fecaca;border-radius:999px;background:#fff1f2;padding:6px 10px;color:#dc2626;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:800;letter-spacing:1.2px">●&nbsp;&nbsp;${details.eyebrow}</td>
                  </tr>
                </table>
                <h1 style="margin:0 0 15px;color:#1f2937;font-family:Georgia,'Times New Roman',serif;font-size:31px;font-weight:700;line-height:38px;letter-spacing:-.5px">${details.heading}</h1>
                <p style="margin:0;color:#4a5568;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:26px">${details.intro}</p>
                ${actionHtml}
                <div style="margin-top:30px;border-top:1px solid #edf2f7;padding-top:22px">
                  <p style="margin:0;color:#718096;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:19px">${securityNote}</p>
                </div>
              </div>
              <div style="border-top:1px solid #edf2f7;background:#fafafa;padding:18px 40px">
                <p style="margin:0;color:#718096;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-style:italic;line-height:22px">Hear every document, <span style="border-radius:3px;background:#fee2e2;color:#2d3748;padding:1px 3px;font-style:normal">highlighted word by word.</span></p>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 10px 0;color:#a0aec0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:1.3px">EPUB&nbsp;&nbsp;·&nbsp;&nbsp;PDF&nbsp;&nbsp;·&nbsp;&nbsp;TXT&nbsp;&nbsp;·&nbsp;&nbsp;MD&nbsp;&nbsp;·&nbsp;&nbsp;DOCX</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  const text = [details.heading, '', details.intro, execution.actionUrl ? `\n${execution.actionUrl}\n` : '', `This message expires at ${expiry}.`, 'If you did not request it, you can ignore this email.'].join('\n');
  return { subject: details.subject, html, text };
}

async function resolveExecution(payload: EmailDeliveryJobRequest): Promise<EmailExecution> {
  const config = getEmailExecutionBrokerConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as EmailExecution | { error?: string } | null;
    if (!response.ok || !body || !('apiKey' in body)) {
      const code = body && 'error' in body && body.error ? body.error : 'EMAIL_BROKER_UNAVAILABLE';
      throw new EmailDeliveryError(code, response.status >= 500);
    }
    return body;
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError('EMAIL_BROKER_UNAVAILABLE', true);
  } finally {
    clearTimeout(timeout);
  }
}

const TRANSIENT_RESEND_ERRORS = new Set([
  'rate_limit_exceeded', 'concurrent_idempotent_requests', 'application_error', 'internal_server_error',
]);

export async function deliverEmail(payload: EmailDeliveryJobRequest): Promise<EmailDeliveryJobResult> {
  if (Date.now() >= payload.expiresAt) throw new EmailDeliveryError('EMAIL_ENVELOPE_EXPIRED', false);
  const execution = await resolveExecution(payload);
  if (execution.deliveryId !== payload.deliveryId || execution.expiresAt !== payload.expiresAt) {
    throw new EmailDeliveryError('EMAIL_BROKER_RESPONSE_INVALID', false);
  }
  const message = renderEmailContent(execution);
  const logo = await readFile(resolveEmailLogoPath());
  const response = await new Resend(execution.apiKey).emails.send({
    from: `${execution.senderName} <${execution.senderEmail}>`,
    to: execution.to,
    ...(execution.replyTo ? { replyTo: execution.replyTo } : {}),
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: [{
      content: logo,
      filename: EMAIL_LOGO_FILENAME,
      contentType: 'image/png',
      contentId: EMAIL_LOGO_CONTENT_ID,
    }],
  }, { idempotencyKey: execution.deliveryId });
  if (response.error) {
    const retryable = TRANSIENT_RESEND_ERRORS.has(response.error.name)
      || (response.error.statusCode !== null && response.error.statusCode >= 500);
    throw new EmailDeliveryError(
      `RESEND_${response.error.name.toUpperCase()}`,
      retryable,
      parseRetryAfter(response.headers),
    );
  }
  return { deliveryId: payload.deliveryId, status: 'accepted', resendMessageId: response.data.id };
}
