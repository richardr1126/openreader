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
  return `${parsedPdfArtifactPrefix(input)}${encodeParserVersion(input.parserVersion ?? PDF_PARSER_VERSION)}.json`;
}

export function parsedPdfArtifactPrefix(input: {
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
  return `${input.prefix}/documents_v1/parsed_v2/${namespaceSegment}${input.documentId}/`;
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
const SAFE_NAMESPACE_REGEX_WITH_DEFAULT = /^[a-zA-Z0-9._-]{1,128}$/;

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
  if (!SAFE_PLAN_SIGNATURE_REGEX.test(input.planSignature)) {
    throw new Error(`Invalid playback plan signature: ${input.planSignature}`);
  }
  const version = Math.max(0, Math.floor(input.documentVersion));
  return `${ttsPlaybackPlanArtifactPrefix(input)}${version}/${input.readerType}/${input.planSignature}.json`;
}

export function ttsPlaybackPlanArtifactPrefix(input: {
  documentId: string;
  prefix: string;
}): string {
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  return `${input.prefix}/tts_playback_plan_v1/${input.documentId}/`;
}

const SAFE_HASH_SEGMENT_REGEX = /^[a-f0-9]{8,128}$/i;
const SAFE_OBJECT_PATH_SEGMENT_REGEX = /^[a-zA-Z0-9._=-]{1,256}$/;

/**
 * Durable per-segment "sidecar": the duration + word alignment + audio key for
 * one playback segment, keyed by user storage scope + document/version +
 * settings hash + **plan ordinal**.
 *
 * Keyed by ordinal (not segment id) on purpose: it gives every segment its own
 * object that the stream reader can address directly from the plan (ordinal)
 * without recomputing segment ids. It is also the per-ordinal coordination
 * record: `generating` is a short-lived lease, while `completed` points at
 * content-addressed audio. There is no shared aggregate index to read-merge-
 * write, so progress cannot lose unrelated segment completions. See
 * PLAYBACK_ARCHITECTURE.md.
 */
export function ttsPlaybackSegmentSidecarArtifactKey(input: {
  storageUserHash: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  ordinal: number;
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
  const ordinal = Math.max(0, Math.floor(input.ordinal));
  return `${input.prefix}/tts_playback_segments_v1/users/${input.storageUserHash}/docs/${input.documentId}/${version}/${input.settingsHash}/segments/${ordinal}.json`;
}

/**
 * Playback export artifacts are user/document-scoped so ownership cleanup can
 * list one bounded prefix instead of scanning a global artifact-id namespace.
 * The deterministic artifact id still provides variant identity within the
 * scope. Like segment audio keys, no namespace segment is used: the worker job
 * request carries no namespace and scope isolation comes from the user id.
 */
export function ttsPlaybackExportArtifactScopePrefix(input: {
  storageUserId: string;
  documentId?: string;
  prefix: string;
}): string {
  const userSegment = `${input.prefix}/tts_playback_exports_v1/users/${encodeURIComponent(input.storageUserId)}/`;
  if (input.documentId === undefined) return userSegment;
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  return `${userSegment}docs/${input.documentId}/`;
}

function ttsPlaybackExportArtifactDirPrefix(input: {
  artifactId: string;
  storageUserId: string;
  documentId: string;
  prefix: string;
}): string {
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.artifactId)) {
    throw new Error(`Invalid playback export artifact id: ${input.artifactId}`);
  }
  return `${ttsPlaybackExportArtifactScopePrefix(input)}${input.artifactId}/`;
}

export function ttsPlaybackExportArtifactKey(input: {
  artifactId: string;
  storageUserId: string;
  documentId: string;
  format: 'mp3' | 'm4b';
  prefix: string;
}): string {
  return `${ttsPlaybackExportArtifactDirPrefix(input)}artifact.${input.format}`;
}

export function ttsPlaybackExportMetadataArtifactKey(input: {
  artifactId: string;
  storageUserId: string;
  documentId: string;
  prefix: string;
}): string {
  return `${ttsPlaybackExportArtifactDirPrefix(input)}metadata.json`;
}

function previewNamespaceSegment(namespace: string | null): string {
  return namespace && SAFE_NAMESPACE_REGEX_WITH_DEFAULT.test(namespace) ? namespace : '_default';
}

export function documentPreviewArtifactPrefix(input: {
  documentId: string;
  namespace: string | null;
  prefix: string;
}): string {
  if (!DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  return `${input.prefix}/document_previews_v1/ns/${previewNamespaceSegment(input.namespace)}/${input.documentId}/`;
}

export function documentPreviewArtifactKey(input: {
  documentId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${documentPreviewArtifactPrefix(input)}card-400.jpg`;
}

export function documentPreviewMetadataArtifactKey(input: {
  documentId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${documentPreviewArtifactPrefix(input)}metadata.json`;
}

function conversionNamespaceSegment(namespace: string | null): string {
  return namespace && SAFE_NAMESPACE_REGEX_WITH_DEFAULT.test(namespace) ? namespace : '_default';
}

export function documentConversionArtifactPrefix(input: {
  conversionId: string;
  namespace: string | null;
  prefix: string;
}): string {
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.conversionId)) {
    throw new Error(`Invalid document conversion id: ${input.conversionId}`);
  }
  return `${input.prefix}/document_conversions_v1/docx/ns/${conversionNamespaceSegment(input.namespace)}/${input.conversionId}/`;
}

export function documentConversionArtifactKey(input: {
  conversionId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${documentConversionArtifactPrefix(input)}artifact.pdf`;
}

export function documentConversionMetadataArtifactKey(input: {
  conversionId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${documentConversionArtifactPrefix(input)}metadata.json`;
}

export function accountExportArtifactPrefix(input: {
  artifactId: string;
  storageUserId: string;
  namespace: string | null;
  prefix: string;
}): string {
  if (!SAFE_HASH_SEGMENT_REGEX.test(input.artifactId)) {
    throw new Error(`Invalid account export artifact id: ${input.artifactId}`);
  }
  const namespaceSegment = input.namespace && SAFE_NAMESPACE_REGEX_WITH_DEFAULT.test(input.namespace)
    ? `ns/${input.namespace}/`
    : '';
  return `${input.prefix}/account_exports_v1/${namespaceSegment}users/${encodeURIComponent(input.storageUserId)}/${input.artifactId}/`;
}

export function accountExportArtifactKey(input: {
  artifactId: string;
  storageUserId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${accountExportArtifactPrefix(input)}artifact.zip`;
}

export function accountExportMetadataArtifactKey(input: {
  artifactId: string;
  storageUserId: string;
  namespace: string | null;
  prefix: string;
}): string {
  return `${accountExportArtifactPrefix(input)}metadata.json`;
}
