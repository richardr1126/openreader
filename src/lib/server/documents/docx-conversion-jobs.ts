import { createHash } from 'node:crypto';
import {
  headTempDocumentBlob,
  isMissingBlobError,
  tempDocumentUploadKey,
} from '@/lib/server/documents/blobstore';
import type { DocumentConversionRequest } from '@/lib/server/compute-worker/protocol';

export type DocxConversionUpload = {
  token: string;
};

type TempUploadHead = {
  contentType: string;
  size: number;
  lastModified: number;
  eTag: string | null;
};

export async function headTempUploadForConversion(input: {
  token: string;
  userId: string;
  namespace: string | null;
}): Promise<TempUploadHead> {
  const RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const head = await headTempDocumentBlob(input.token, input.userId, input.namespace);
      return {
        contentType: head.contentType ?? 'application/octet-stream',
        size: head.contentLength,
        lastModified: head.lastModified ?? Date.now(),
        eTag: head.eTag ?? null,
      };
    } catch (error) {
      lastError = error;
      if (isMissingBlobError(error) && attempt < RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Temporary upload is unavailable');
}

export function buildDocxConversionRequest(input: {
  upload: DocxConversionUpload;
  temp: TempUploadHead;
  userId: string;
  namespace: string | null;
}): DocumentConversionRequest {
  const sourceObjectKey = tempDocumentUploadKey(input.upload.token, input.userId, input.namespace);
  const sourceContentType = input.temp.contentType || 'application/octet-stream';
  const conversionId = createHash('sha256')
    .update([
      input.namespace ?? '',
      input.userId,
      input.upload.token,
      sourceObjectKey,
      sourceContentType,
      input.temp.eTag ?? '',
      String(Math.max(0, Math.floor(input.temp.size))),
      String(Math.max(0, Math.floor(input.temp.lastModified))),
    ].join('\0'))
    .digest('hex');
  return {
    conversionId,
    namespace: input.namespace,
    sourceObjectKey,
    sourceLastModifiedMs: input.temp.lastModified,
    sourceContentType,
    sourceEtag: input.temp.eTag,
  };
}
