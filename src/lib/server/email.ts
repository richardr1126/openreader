import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

export function isSmtpConfigured(): boolean {
  return !!process.env.SMTP_URL;
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const url = process.env.SMTP_URL;
  if (!url) {
    throw new Error('SMTP is not configured. Set the SMTP_URL environment variable.');
  }

  transporter = nodemailer.createTransport(url);
  return transporter;
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  appName = 'OpenReader',
): Promise<void> {
  const from = process.env.SMTP_FROM;
  const transport = getTransporter();

  await transport.sendMail({
    ...(from ? { from: `"${appName}" <${from}>` } : {}),
    to,
    subject: `Reset your ${appName} password`,
    text: [
      `You requested a password reset for your ${appName} account.`,
      '',
      'Click the link below to set a new password:',
      resetUrl,
      '',
      'This link will expire in 1 hour.',
      '',
      `If you didn't request this, you can safely ignore this email.`,
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px; font-size: 20px; color: #1a1a1a;">Reset your password</h2>
        <p style="color: #444; line-height: 1.5;">
          You requested a password reset for your ${appName} account.
        </p>
        <div style="margin: 24px 0;">
          <a href="${resetUrl}"
             style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 500;">
            Reset Password
          </a>
        </div>
        <p style="color: #666; font-size: 14px; line-height: 1.5;">
          This link will expire in 1 hour. If you didn&rsquo;t request this, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">
          If the button doesn&rsquo;t work, copy and paste this URL into your browser:<br />
          <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
        </p>
      </div>
    `.trim(),
  });
}
