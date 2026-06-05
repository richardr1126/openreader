import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';

export interface PdfParseSnapshot {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  opId: string | null;
  error?: string | null;
}
