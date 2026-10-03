import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  GutendexSettingsError,
  getPublicGutendexSettings,
  updateGutendexSettings,
  type GutendexSettingsPatch,
} from '@/lib/server/admin/gutendex-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  return NextResponse.json(await getPublicGutendexSettings(), {
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
  const allowed = new Set(['enabled', 'serverUrl', 'apiKey']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    return NextResponse.json({ error: `Unknown field: ${unknown[0]}` }, { status: 400 });
  }
  try {
    const settings = await updateGutendexSettings(body as GutendexSettingsPatch);
    return NextResponse.json(settings, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    if (error instanceof GutendexSettingsError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
