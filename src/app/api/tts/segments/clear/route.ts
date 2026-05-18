import { NextRequest, NextResponse } from 'next/server';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { clearTtsSegmentCache } from '@/lib/server/tts/segments-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseBody(value: unknown): { documentId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.documentId !== 'string' || !rec.documentId.trim()) return null;
  return { documentId: rec.documentId.trim().toLowerCase() };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    const cleared = await clearTtsSegmentCache({
      userId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
    });

    return NextResponse.json({
      documentId: parsed.documentId,
      ...cleared,
    });
  } catch (error) {
    console.error('Error clearing TTS segment cache:', error);
    return NextResponse.json({ error: 'Failed to clear TTS segment cache' }, { status: 500 });
  }
}
