import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth/auth';
import { fetchOpenRouterModels } from '@openreader/tts/openrouter';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await (await getAuth()).api.getSession({ headers: req.headers });
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ models: await fetchOpenRouterModels(req.signal) }, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch {
    return errorResponse(new Error('OpenRouter speech catalog is unavailable'), {
      apiErrorMessage: 'Could not load OpenRouter models. Retry or enter a model ID.',
      normalize: { code: 'TTS_MODELS_UNAVAILABLE', errorClass: 'upstream', httpStatus: 502 },
    });
  }
}
