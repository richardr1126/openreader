import { and, eq, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { buildTtsPlaybackPlanningInput, parseTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { resolveSegmentDocumentScope, type ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export type DocumentStorageScope = {
  documentId: string;
  scope: ResolvedSegmentDocumentScope;
  /** The cache identity the reader would request now for this document. */
  settingsHash: string;
};

/**
 * Resolve the current playback cache identity for a document from the same
 * settings payload the reader sends for plans and sessions, so "current" audio
 * here is exactly the audio the next playback would reuse.
 */
export async function resolveDocumentStorageScope(
  request: NextRequest,
): Promise<DocumentStorageScope | Response> {
  const parsed = parseTtsPlaybackRequestBody(await request.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
  if (scope instanceof Response) return scope;
  const { settingsHash } = await buildTtsPlaybackPlanningInput(parsed, scope);
  return { documentId: parsed.documentId, scope, settingsHash };
}

export async function listOwnedDocumentIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, userId)) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Re-check ownership right before deleting, so a just-restored document keeps its audio. */
export async function filterOwnedDocumentIds(userId: string, documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), inArray(documents.id, documentIds))) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
