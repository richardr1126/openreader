import { findAudiobookFile, isAudiobookFileId } from '@/lib/server/audiobooks/request';
import { getAuthContext } from '@/lib/server/auth/auth';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { resolveUserDocumentScope } from '@/lib/server/tts/segments-auth';
import type { AudiobookDownload } from '@/types/tts-export';

/**
 * What a person opening an audiobook download link may see. Signed-out and
 * no-access answers are the same for every link, so they reveal nothing about it.
 */
export async function resolveAudiobookDownload(headers: Headers, rawDocumentId: string, artifactId: string): Promise<AudiobookDownload> {
  const { user } = await getAuthContext({ headers });
  if (!user) return { access: 'sign-in' };
  const isAnonymous = Boolean(user.isAnonymous);
  const documentId = rawDocumentId.trim().toLowerCase();
  const scope = await resolveUserDocumentScope({ userId: user.id, isAnonymous }, documentId);
  if (!scope) return isAnonymous ? { access: 'sign-in' } : { access: 'denied', accountName: user.name };

  const webPath = `/${scope.readerType}/${documentId}`;
  const artifact = isAudiobookFileId(artifactId)
    ? await findAudiobookFile(scope, documentId, artifactId).catch((error) => {
      serverLogger.warn({ event: 'audiobooks.download_page_failed', error: errorToLog(error) }, 'Failed to read the audiobook file');
      return null;
    })
    : null;
  if (!artifact) return { access: 'missing', webPath };
  return {
    access: 'ready',
    webPath,
    fileUrl: `/api/v1/documents/${documentId}/audiobooks/files/${artifactId}`,
    filename: artifact.dispositionFilename ?? '',
  };
}
