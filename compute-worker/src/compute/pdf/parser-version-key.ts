import { PDF_PARSER_VERSION } from './parser-version';

export function encodeParserVersion(
  parserVersion: string,
  defaultVersion = PDF_PARSER_VERSION,
): string {
  const normalized = parserVersion.trim() || defaultVersion;
  return encodeURIComponent(normalized);
}
