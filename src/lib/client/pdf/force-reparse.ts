import type { PdfParseStatus } from '@/types/parsed-pdf';

export const FORCE_REPARSE_CONFIRM_TITLE = 'Reparse PDF Layout?';
export const FORCE_REPARSE_CONFIRM_MESSAGE = 'This reruns page layout parsing from scratch and can take a while on large documents.';
export const FORCE_REPARSE_CONFIRM_TEXT = 'Reparse Now';

export function isForceReparseDisabled(status: PdfParseStatus | null): boolean {
  return status === 'pending' || status === 'running';
}
