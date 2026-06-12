import { PDF_PARSER_VERSION } from '../inference/pdf/parser-version';
import { encodeParserVersion } from '../inference/pdf/parser-version-key';

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
