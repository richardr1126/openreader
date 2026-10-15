import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  getComputeWorkerClient,
  isComputeWorkerConflictError,
  isComputeWorkerUnavailableError,
} from '@/lib/server/compute-worker/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Kokoro, the voice model the compute worker runs itself. */
const MODEL = 'kokoro-82m';
const UNAVAILABLE = { error: 'The compute worker is not reachable right now.' };

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;
  try {
    const status = await getComputeWorkerClient().getModelStatus(MODEL);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (isComputeWorkerUnavailableError(error)) return NextResponse.json(UNAVAILABLE, { status: 503 });
    throw error;
  }
}

/** Starts the download, or joins the one already running. */
export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;
  try {
    const operation = await getComputeWorkerClient().createModelDownloadOperation(MODEL);
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    if (isComputeWorkerUnavailableError(error)) return NextResponse.json(UNAVAILABLE, { status: 503 });
    throw error;
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;
  try {
    await getComputeWorkerClient().removeModel(MODEL);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isComputeWorkerConflictError(error)) {
      return NextResponse.json({ error: 'Kokoro is downloading. Cancel the download before removing it.' }, { status: 409 });
    }
    if (isComputeWorkerUnavailableError(error)) return NextResponse.json(UNAVAILABLE, { status: 503 });
    throw error;
  }
}
