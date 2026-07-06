import { createHash } from 'node:crypto';
import {
  buildTtsPlaybackCanonicalScopeKey,
  buildTtsPlaybackExportArtifactId,
} from '@openreader/tts/playback-scope';
import { DOCX_CONVERTER_VERSION, DOCUMENT_PREVIEW_RENDERER_VERSION, PDF_PARSER_VERSION } from './contracts';

export function buildPdfOperationKey(input: {
  documentId: string;
  namespace: string | null;
  documentObjectKey: string;
  replaceToken?: string;
}, parserVersion = PDF_PARSER_VERSION): string {
  return [
    'pdf_layout',
    'v1',
    parserVersion,
    input.documentId,
    input.namespace ?? '',
    input.documentObjectKey,
    input.replaceToken?.trim() || '',
  ].join('|');
}

export function buildDocumentPreviewOperationKey(input: {
  documentId: string;
  namespace: string | null;
  documentType: 'pdf' | 'epub';
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  previewKind: 'card';
  rendererVersion?: string;
}): string {
  return [
    'document_preview',
    'v1',
    input.rendererVersion?.trim() || DOCUMENT_PREVIEW_RENDERER_VERSION,
    input.documentId,
    input.namespace ?? '',
    input.documentType,
    input.previewKind,
    input.sourceObjectKey,
    String(Math.max(0, Math.floor(input.sourceLastModifiedMs))),
  ].join('|');
}

export function buildDocumentConversionOperationKey(input: {
  conversionId: string;
  namespace: string | null;
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  sourceContentType: string;
  sourceEtag?: string | null;
  converterVersion?: string;
}): string {
  return [
    'document_conversion',
    'v1',
    input.converterVersion?.trim() || DOCX_CONVERTER_VERSION,
    input.conversionId,
    input.namespace ?? '',
    input.sourceObjectKey,
    String(Math.max(0, Math.floor(input.sourceLastModifiedMs))),
    input.sourceContentType.trim().toLowerCase() || 'application/octet-stream',
    input.sourceEtag?.trim() || '',
  ].join('|');
}

export function documentConversionSubjectFromOperationKey(opKey: string): {
  kind: 'document_conversion';
  conversionId: string;
  namespace: string | null;
} | null {
  const parts = opKey.split('|');
  const [kind, version, , conversionId, namespace] = parts;
  if (kind !== 'document_conversion' || version !== 'v1' || !conversionId) return null;
  return {
    kind: 'document_conversion',
    conversionId,
    namespace: namespace || null,
  };
}

export function documentPreviewSubjectFromOperationKey(opKey: string): {
  kind: 'document_preview';
  documentId: string;
  namespace: string | null;
  previewKind: 'card';
} | null {
  const parts = opKey.split('|');
  const [kind, version, , documentId, namespace, , previewKind] = parts;
  if (kind !== 'document_preview' || version !== 'v1' || !documentId || previewKind !== 'card') return null;
  return {
    kind: 'document_preview',
    documentId,
    namespace: namespace || null,
    previewKind,
  };
}

export function pdfSubjectFromOperationKey(opKey: string): {
  kind: 'pdf_layout';
  documentId: string;
  namespace: string | null;
} | null {
  const [kind, version, , documentId, namespace] = opKey.split('|');
  if (kind !== 'pdf_layout' || version !== 'v1' || !documentId) return null;
  return {
    kind: 'pdf_layout',
    documentId,
    namespace: namespace || null,
  };
}

export function buildTtsPlaybackOperationKey(input: {
  sessionId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  planObjectKey: string;
  generationRunId?: string;
  generationExtent?: 'window' | 'document';
}): string {
  const scopeHash = createHash('sha256').update(buildTtsPlaybackCanonicalScopeKey({
    storageUserId: input.storageUserId,
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    readerType: input.readerType,
    settingsHash: input.settingsHash,
    planObjectKey: input.planObjectKey,
  })).digest('hex');
  const intent = input.generationExtent === 'document'
    ? 'document'
    : `live:${input.generationRunId?.trim() || 'initial'}`;
  return [
    'tts_playback',
    'v1',
    input.documentId,
    String(input.documentVersion),
    input.settingsHash,
    scopeHash,
    input.sessionId,
    intent,
  ].join('|');
}

export function buildTtsPlaybackPlanOperationKey(input: {
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  planSignature: string;
}): string {
  return [
    'tts_playback_plan',
    'v1',
    input.documentId,
    String(input.documentVersion),
    input.readerType,
    input.settingsHash,
    input.planSignature,
  ].join('|');
}

export { buildTtsPlaybackExportArtifactId };

export function buildTtsPlaybackExportOperationKey(input: {
  artifactId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  format: 'mp3' | 'm4b';
  speed: number;
}): string {
  const speed = Math.max(0.5, Math.min(3, Number.isFinite(input.speed) ? input.speed : 1));
  return [
    'tts_playback_export',
    'v1',
    input.documentId,
    String(input.documentVersion),
    input.settingsHash,
    input.artifactId,
    input.format,
    speed.toFixed(2),
  ].join('|');
}

export function ttsPlaybackSubjectFromOperationKey(opKey: string): {
  kind: 'tts_playback';
  documentId: string;
  sessionId: string;
} | null {
  const parts = opKey.split('|');
  const [kind, version, documentId] = parts;
  // tts_playback | v1 | documentId | version | settingsHash | scopeHash | sessionId | intent
  const sessionId = parts[6];
  if (kind !== 'tts_playback' || version !== 'v1' || !documentId || !sessionId) return null;
  return { kind: 'tts_playback', documentId, sessionId };
}

export function ttsPlaybackExportSubjectFromOperationKey(opKey: string): {
  kind: 'tts_playback_export';
  documentId: string;
  artifactId: string;
  format: 'mp3' | 'm4b';
} | null {
  const parts = opKey.split('|');
  const [kind, version, documentId] = parts;
  const artifactId = parts[5];
  const format = parts[6];
  if (
    kind !== 'tts_playback_export'
    || version !== 'v1'
    || !documentId
    || !artifactId
    || (format !== 'mp3' && format !== 'm4b')
  ) {
    return null;
  }
  return { kind: 'tts_playback_export', documentId, artifactId, format };
}

export function ttsPlaybackPlanSubjectFromOperationKey(opKey: string): {
  kind: 'tts_playback_plan';
  documentId: string;
  settingsHash: string;
  planSignature: string;
} | null {
  // tts_playback_plan | v1 | documentId | version | readerType | settingsHash | planSignature | ...
  const parts = opKey.split('|');
  const [kind, version, documentId] = parts;
  const settingsHash = parts[5];
  const planSignature = parts[6];
  if (kind !== 'tts_playback_plan' || version !== 'v1' || !documentId || !settingsHash || !planSignature) {
    return null;
  }
  return { kind: 'tts_playback_plan', documentId, settingsHash, planSignature };
}
