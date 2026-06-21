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
  startOrdinal: number;
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
    String(input.startOrdinal),
    input.sessionId,
  ].join('|');
}

export function ttsPlaybackSubjectFromOperationKey(opKey: string): {
  kind: 'tts_playback';
  documentId: string;
  sessionId: string;
} | null {
  // tts_playback | v1 | documentId | version | settingsHash | startOrdinal | sessionId
  const parts = opKey.split('|');
  const [kind, version, documentId] = parts;
  const sessionId = parts[6];
  if (kind !== 'tts_playback' || version !== 'v1' || !documentId || !sessionId) return null;
  return { kind: 'tts_playback', documentId, sessionId };
}
