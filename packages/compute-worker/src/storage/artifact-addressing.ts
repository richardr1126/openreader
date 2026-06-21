import { PDF_PARSER_VERSION } from '../operations/contracts';
import { encodeParserVersion } from '../operations/contracts';

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

export function parsedPdfArtifactKey(input: {
  documentId: string;
  namespace: string | null;
  prefix: string;
  parserVersion?: string;
}): string {
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  const namespace = input.namespace && SAFE_NAMESPACE_REGEX.test(input.namespace)
    ? input.namespace
    : null;
  const namespaceSegment = namespace ? `ns/${namespace}/` : '';
  return `${input.prefix}/documents_v1/parsed_v2/${namespaceSegment}${input.documentId}/${encodeParserVersion(input.parserVersion ?? PDF_PARSER_VERSION)}.json`;
}

/**
 * Object key for a document's raw uploaded source bytes (the original PDF /
 * EPUB / HTML). Mirrors the app's `documentKey` in documents/blobstore.ts.
 */
export function documentSourceKey(input: {
  documentId: string;
  namespace: string | null;
  prefix: string;
}): string {
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  const namespace = input.namespace && SAFE_NAMESPACE_REGEX.test(input.namespace)
    ? input.namespace
    : null;
  const namespaceSegment = namespace ? `ns/${namespace}/` : '';
  return `${input.prefix}/documents_v1/${namespaceSegment}${input.documentId}`;
}

const SAFE_SESSION_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Object key for a TTS playback session's persisted plan / timeline artifact.
 * SQL stores only the key + status; the full reusable plan and timeline live
 * in object storage. Keyed per session id.
 */
export function ttsPlaybackArtifactKey(input: {
  sessionId: string;
  kind: 'plan' | 'timeline';
  prefix: string;
}): string {
  if (!SAFE_SESSION_ID_REGEX.test(input.sessionId)) {
    throw new Error(`Invalid playback session id: ${input.sessionId}`);
  }
  return `${input.prefix}/tts_playback_v1/${input.sessionId}/${input.kind}.json`;
}
