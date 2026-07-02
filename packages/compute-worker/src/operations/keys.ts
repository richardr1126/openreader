import { createHash } from 'node:crypto';
import { buildTtsPlaybackCanonicalScopeKey } from '@openreader/tts/playback-scope';
import { PDF_PARSER_VERSION } from './contracts';

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
