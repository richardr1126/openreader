/**
 * A reading plan was requested for a PDF layout that a reparse has since
 * replaced. Planning again cannot recover it, so it is not retried.
 */
export class PdfLayoutChangedError extends Error {
  readonly retryable = false;
  readonly code = 'PDF_LAYOUT_CHANGED';

  constructor() {
    super('The PDF was reparsed after this reading plan was requested. Open the document or request it again.');
    this.name = 'PdfLayoutChangedError';
  }
}
