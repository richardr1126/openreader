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

const SAFE_PLAN_SIGNATURE_REGEX = /^[a-f0-9]{8,64}$/i;

/**
 * Object key for a document's reusable, position-independent canonical TTS plan.
 *
 * Unlike {@link ttsPlaybackArtifactKey} this is NOT keyed by session: the plan
 * (segment list + ordinals + locators, voice/speed-independent) is identical for
 * a given document version + reader type + segmentation signature, so every
 * playback session that jumps/seeks within the same document reuses one cached
 * plan with stable absolute ordinals instead of re-deriving a position-relative
 * one. `planSignature` is a hash of the segmentation knobs (maxBlockLength,
 * language, enforceSourceBoundaries, skipBlockKinds, isPlainText, namespace).
 */
export function ttsPlaybackPlanArtifactKey(input: {
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  planSignature: string;
  prefix: string;
}): string {
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  if (!SAFE_PLAN_SIGNATURE_REGEX.test(input.planSignature)) {
    throw new Error(`Invalid playback plan signature: ${input.planSignature}`);
  }
  const version = Math.max(0, Math.floor(input.documentVersion));
  return `${input.prefix}/tts_playback_plan_v1/${input.documentId}/${version}/${input.readerType}/${input.planSignature}.json`;
}

const SAFE_HASH_SEGMENT_REGEX = /^[a-f0-9]{8,128}$/i;
const SAFE_OBJECT_PATH_SEGMENT_REGEX = /^[a-zA-Z0-9._=-]{1,256}$/;

/**
 * Durable generated-audio metadata for one playback segment. The object is
 * keyed by user storage scope + document/version + settings hash + segment id.
 */
export function ttsPlaybackSegmentMetadataArtifactKey(input: {
  storageUserHash: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  segmentId: string;
  prefix: string;
}): string {
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.storageUserHash)) {
    throw new Error(`Invalid playback storage user hash: ${input.storageUserHash}`);
  }
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  if (!SAFE_OBJECT_PATH_SEGMENT_REGEX.test(input.settingsHash)) {
    throw new Error(`Invalid playback settings hash: ${input.settingsHash}`);
  }
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.segmentId)) {
    throw new Error(`Invalid playback segment id: ${input.segmentId}`);
  }
  const version = Math.max(0, Math.floor(input.documentVersion));
  return `${input.prefix}/tts_playback_segments_v1/users/${input.storageUserHash}/docs/${input.documentId}/${version}/${input.settingsHash}/segments/${input.segmentId}.json`;
}

/**
 * Compact index used by stream/sidebar readers to avoid database joins or S3
 * list operations. It points at completed per-segment metadata artifacts.
 */
export function ttsPlaybackSegmentIndexArtifactKey(input: {
  storageUserHash: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  prefix: string;
}): string {
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.storageUserHash)) {
    throw new Error(`Invalid playback storage user hash: ${input.storageUserHash}`);
  }
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  if (!SAFE_OBJECT_PATH_SEGMENT_REGEX.test(input.settingsHash)) {
    throw new Error(`Invalid playback settings hash: ${input.settingsHash}`);
  }
  const version = Math.max(0, Math.floor(input.documentVersion));
  return `${input.prefix}/tts_playback_segments_v1/users/${input.storageUserHash}/docs/${input.documentId}/${version}/${input.settingsHash}/index.json`;
}
