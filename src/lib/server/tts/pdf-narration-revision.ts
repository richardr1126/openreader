import { isMissingBlobError } from '@/lib/server/documents/blobstore';
import { resolveCurrentPdfParse } from '@/lib/server/pdf-parse/operation';
import { getS3Config } from '@/lib/server/storage/s3';
import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

/**
 * The PDF narration revision a playback request belongs to. A reparse that
 * changes the narrated blocks gives the layout a new revision, and plans and
 * segment audio are keyed by it. A request naming a saved plan keeps that
 * plan's revision, so open readers and pinned exports keep their audio. Any
 * other request uses the current layout's.
 */
export async function resolvePdfNarrationRevision(
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  planObjectKey?: string,
): Promise<string | null> {
  // Only this document's plans are read; the key comes from the caller.
  if (planObjectKey?.startsWith(`${getS3Config().prefix}/tts_playback_plan_v1/${documentId}/${scope.documentVersion}/${scope.readerType}/`)) {
    try {
      const { artifact } = await readTtsPlaybackPlanArtifact(planObjectKey);
      if (artifact.documentId === documentId) return artifact.narrationRevision ?? null;
    } catch (error) {
      // A cleared plan is planned again from the current layout.
      if (!isMissingBlobError(error)) throw error;
    }
  }
  const { artifact } = await resolveCurrentPdfParse({ documentId, namespace: null });
  return artifact?.narrationRevision ?? null;
}
