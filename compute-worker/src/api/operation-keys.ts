import { createHash } from 'node:crypto';
import { PDF_PARSER_VERSION } from '../inference/pdf/parser-version';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function buildWhisperOperationKey(input: {
  audioObjectKey: string;
  text: string;
  lang?: string;
  cacheKey?: string;
}): string {
  const cacheKey = input.cacheKey?.trim();
  if (cacheKey) {
    return `whisper_align|v1|cache|${cacheKey}|${input.audioObjectKey}`;
  }
  return [
    'whisper_align',
    'v1',
    input.audioObjectKey,
    input.lang ?? '',
    sha256Hex(input.text),
  ].join('|');
}

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
