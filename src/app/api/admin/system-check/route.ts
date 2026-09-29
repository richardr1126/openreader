import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { runSystemCheck } from '@/lib/server/admin/system-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  return NextResponse.json(await runSystemCheck(), { headers: { 'Cache-Control': 'no-store' } });
}
