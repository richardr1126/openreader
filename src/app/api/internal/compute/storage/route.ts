import { NextRequest, NextResponse } from 'next/server';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import { beginAudioMeasurement, reportAudioMeasurement } from '@/lib/server/storage/usage';
import { readApiJson } from '@/lib/server/api/body';
import { ApiRequestError } from '@/lib/server/api/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest): Promise<Response> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth !== 'authorized') return NextResponse.json({ error: 'Storage broker unavailable' }, { status: auth === 'unconfigured' ? 503 : 401 });
  let body: Record<string, unknown>;
  try { body = await readApiJson(request, 2048); }
  catch (error) { if (error instanceof ApiRequestError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error; }
  if (!body || typeof body.userId !== 'string' || !body.userId.length || body.userId.length > 256
    || typeof body.documentId !== 'string' || !/^[a-f0-9]{64}$/i.test(body.documentId)) return NextResponse.json({ error: 'Invalid scope' }, { status: 400 });
  if (body.action === 'begin' || body.action === 'begin-clear') {
    return NextResponse.json({ revision: await beginAudioMeasurement(body.userId, body.documentId, body.action === 'begin-clear') }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (body.action !== 'report' || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1 || typeof body.audioBytes !== 'number' || !Number.isSafeInteger(body.audioBytes) || body.audioBytes < 0) return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
  await reportAudioMeasurement({ userId: body.userId, documentId: body.documentId, revision: body.revision, audioBytes: body.audioBytes });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
