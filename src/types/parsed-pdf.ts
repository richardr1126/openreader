export type ParsedPdfBlockKind =
  | 'title'
  | 'section-header'
  | 'paragraph'
  | 'list-item'
  | 'caption'
  | 'table'
  | 'picture'
  | 'page-header'
  | 'page-footer'
  | 'footnote'
  | 'formula';

export interface ParsedPdfBlockFragment {
  page: number;
  bbox: [number, number, number, number];
  text: string;
  readingOrder: number;
  modelConfidence?: number;
}

export interface ParsedPdfBlock {
  id: string;
  kind: ParsedPdfBlockKind;
  fragments: ParsedPdfBlockFragment[];
  text: string;
  parentSectionId?: string;
}

export interface ParsedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: ParsedPdfBlock[];
}

export interface ParsedPdfDocument {
  schemaVersion: 1;
  documentId: string;
  parserVersion: string;
  parsedAt: number;
  pages: ParsedPdfPage[];
}

export type PdfParseStatus = 'pending' | 'running' | 'ready' | 'failed' | 'unsupported';
