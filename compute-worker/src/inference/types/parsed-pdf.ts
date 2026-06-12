export type ParsedPdfBlockKind =
  | 'abstract'
  | 'algorithm'
  | 'aside_text'
  | 'chart'
  | 'content'
  | 'formula'
  | 'doc_title'
  | 'figure_title'
  | 'footer'
  | 'footnote'
  | 'formula_number'
  | 'header'
  | 'image'
  | 'number'
  | 'paragraph_title'
  | 'reference'
  | 'reference_content'
  | 'seal'
  | 'table'
  | 'text'
  | 'vision_footnote';

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

export type PdfParseStatus = 'pending' | 'running' | 'ready' | 'failed';
export type PdfParsePhase = 'infer' | 'merge';

export interface PdfParseProgress {
  totalPages: number;
  pagesParsed: number;
  currentPage?: number;
  phase: PdfParsePhase;
}
