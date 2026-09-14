import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  AccountEmailSettingsError,
  getPublicAccountEmailSettings,
  updateAccountEmailSettings,
  type AccountEmailSettingsPatch,
} from '@/lib/server/admin/email-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  return NextResponse.json(await getPublicAccountEmailSettings(), {
    headers: { 'Cache-Control': 'no-store, private' },
  });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected JSON object' }, { status: 400 });
  }
  const allowed = new Set(['enabled', 'senderName', 'senderEmail', 'replyTo', 'apiKey']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    return NextResponse.json({ error: `Unknown field: ${unknown[0]}` }, { status: 400 });
  }
  try {
    const settings = await updateAccountEmailSettings(body as AccountEmailSettingsPatch);
    return NextResponse.json(settings, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    if (error instanceof AccountEmailSettingsError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
