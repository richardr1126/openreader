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
  documentId: string;
  documentVersion: number;
  settingsHash: string;
}): string {
  // One generation job per session: the sessionId makes the key unique, so a
  // re-requested identical session reuses its op while distinct sessions don't
  // collide on the dedup key.
  return [
    'tts_playback',
    'v1',
    input.documentId,
    String(input.documentVersion),
    input.settingsHash,
    input.sessionId,
  ].join('|');
}

export function buildTtsPlaybackPlanOperationKey(input: {
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  planSignature: string;
  startSegmentKey?: string;
  startText?: string;
  startPage?: number;
  startSpineIndex?: number;
  startCharOffset?: number;
}): string {
  return [
    'tts_playback_plan',
    'v1',
    input.documentId,
    String(input.documentVersion),
    input.readerType,
    input.settingsHash,
    input.planSignature,
    input.startSegmentKey?.trim() || '',
    input.startText?.trim() || '',
    input.startPage === undefined ? '' : String(input.startPage),
    input.startSpineIndex === undefined ? '' : String(input.startSpineIndex),
    input.startCharOffset === undefined ? '' : String(input.startCharOffset),
  ].join('|');
}

export function ttsPlaybackSubjectFromOperationKey(opKey: string): {
  kind: 'tts_playback';
  documentId: string;
  sessionId: string;
} | null {
  // tts_playback | v1 | documentId | version | settingsHash | sessionId
  const parts = opKey.split('|');
  const [kind, version, documentId] = parts;
  const sessionId = parts[5];
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
