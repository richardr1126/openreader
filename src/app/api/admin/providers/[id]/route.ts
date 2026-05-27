import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { serverLogger } from '@/lib/server/logger';
import {
  AdminProviderError,
  deleteAdminProvider,
  toMasked,
  updateAdminProvider,
} from '@/lib/server/admin/providers';

export const dynamic = 'force-dynamic';

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const rec = body as Record<string, unknown>;
    const updated = await updateAdminProvider(id, {
      slug: rec.slug as string | undefined,
      displayName: rec.displayName as string | undefined,
      providerType: rec.providerType as never,
      baseUrl: rec.baseUrl as string | null | undefined,
      apiKey: rec.apiKey as string | undefined,
      defaultModel: rec.defaultModel as string | null | undefined,
      defaultInstructions: rec.defaultInstructions as string | null | undefined,
      enabled: rec.enabled as boolean | undefined,
    });
    return NextResponse.json({ provider: toMasked(updated) });
  } catch (error) {
    if (error instanceof AdminProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    serverLogger.error({ err: error }, '[admin/providers/:id] update failed:');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { id } = await context.params;
  try {
    await deleteAdminProvider(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AdminProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    serverLogger.error({ err: error }, '[admin/providers/:id] delete failed:');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
