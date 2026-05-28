import type { ParsedPdfBlockKind } from '@openreader/compute-core/types';

export {
  type ParsedPdfBlock,
  type ParsedPdfBlockFragment,
  type ParsedPdfBlockKind,
  type ParsedPdfDocument,
  type ParsedPdfPage,
} from '@openreader/compute-core/types';

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

export type {
  PdfParsePhase,
  PdfParseProgress,
  PdfParseStatus,
} from '@openreader/compute-core/types';
