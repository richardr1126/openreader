import { NextRequest, NextResponse } from 'next/server';
import type { TTSSentenceAlignment } from '@/types/tts';
import { auth } from '@/lib/server/auth/auth';
import { makeWhisperCacheKey, type WhisperRequestBody } from '@/lib/server/whisper/alignment';
import { getCompute } from '@/lib/server/compute';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const session = await auth?.api.getSession({ headers: req.headers });
    if (auth && !session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as WhisperRequestBody;
    const { text, audio, lang } = body;

    if (!text || !audio || !Array.isArray(audio)) {
      return NextResponse.json(
        { error: 'Missing text or audio in request body' },
        { status: 400 }
      );
    }

    const cacheKey = makeWhisperCacheKey(body);
    const audioBuffer = new Uint8Array(audio).buffer;

    const alignments: TTSSentenceAlignment[] = (await getCompute().alignWords({
      audioBuffer,
      text,
      cacheKey,
      lang,
    })).alignments;

    return NextResponse.json({ alignments }, { status: 200 });
  } catch (error) {
    console.error('Error in whisper route:', error);
    return NextResponse.json(
      {
        error: 'WHISPER_ALIGNMENT_FAILED',
        message: 'Failed to compute word-level alignment',
      },
      { status: 500 }
    );
  }
}
