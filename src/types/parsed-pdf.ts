export {
  type ParsedPdfBlock,
  type ParsedPdfBlockFragment,
  type ParsedPdfBlockKind,
  type ParsedPdfDocument,
  type ParsedPdfPage,
} from '@/lib/server/compute-worker/protocol';

import type { ParsedPdfBlockKind } from '@/lib/server/compute-worker/protocol';

export const PARSED_PDF_BLOCK_KINDS: ParsedPdfBlockKind[] = [
  'abstract',
  'algorithm',
  'aside_text',
  'chart',
  'content',
  'formula',
  'doc_title',
  'figure_title',
  'footer',
  'footnote',
  'formula_number',
  'header',
  'image',
  'number',
  'paragraph_title',
  'reference',
  'reference_content',
  'seal',
  'table',
  'text',
  'vision_footnote',
];

export type PdfParseStatus = 'pending' | 'running' | 'ready' | 'failed';
export type PdfParsePhase = 'infer' | 'merge';
export interface PdfParseProgress {
  totalPages: number;
  pagesParsed: number;
  currentPage?: number;
  phase: PdfParsePhase;
}
