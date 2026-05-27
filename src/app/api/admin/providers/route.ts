import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  AdminProviderError,
  createAdminProvider,
  listAdminProviders,
  toMasked,
} from '@/lib/server/admin/providers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const all = await listAdminProviders();
  return NextResponse.json({ providers: all.map(toMasked) });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const record = await createAdminProvider({
      slug: String((body as Record<string, unknown>).slug ?? ''),
      displayName: String((body as Record<string, unknown>).displayName ?? ''),
      providerType: (body as Record<string, unknown>).providerType as never,
      baseUrl: ((body as Record<string, unknown>).baseUrl as string | null | undefined) ?? null,
      apiKey: String((body as Record<string, unknown>).apiKey ?? ''),
      defaultModel:
        ((body as Record<string, unknown>).defaultModel as string | null | undefined) ?? null,
      defaultInstructions:
        ((body as Record<string, unknown>).defaultInstructions as string | null | undefined) ?? null,
      enabled: ((body as Record<string, unknown>).enabled as boolean | undefined) ?? true,
    });
    return NextResponse.json({ provider: toMasked(record) }, { status: 201 });
  } catch (error) {
    if (error instanceof AdminProviderError) {
      return errorResponse(error, {
        apiErrorMessage: error.message,
        normalize: {
          code: 'ADMIN_PROVIDERS_CREATE_REQUEST_FAILED',
          errorClass: error.status >= 500 ? 'db' : 'validation',
          httpStatus: error.status,
          retryable: error.status >= 500,
        },
      });
    }
    serverLogger.error({
      event: 'admin.providers.create.failed',
      error: errorToLog(error),
    }, 'Admin provider create failed');
    return errorResponse(error, {
      apiErrorMessage: 'Internal error',
      normalize: { code: 'ADMIN_PROVIDERS_CREATE_FAILED', errorClass: 'db' },
    });
  }
}
