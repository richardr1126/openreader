import { NextRequest, NextResponse } from 'next/server';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import { executeMaintenanceStep, InvalidMaintenanceStep } from '@/lib/server/tasks/maintenance-control';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth !== 'authorized') return NextResponse.json({ error: 'Maintenance broker unavailable' }, { status: auth === 'unconfigured' ? 503 : 401 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  try {
    return NextResponse.json(await executeMaintenanceStep(body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof InvalidMaintenanceStep) return NextResponse.json({ error: error.message }, { status: 400 });
    return errorResponse(error, {
      apiErrorMessage: 'Maintenance database step failed',
      normalize: { code: 'MAINTENANCE_DATABASE_STEP_FAILED', errorClass: 'db' },
    });
  }
}
