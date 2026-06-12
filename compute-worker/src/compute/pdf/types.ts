import type { ParsedPdfBlockKind } from '../types/parsed-pdf';

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutRegion {
  bbox: [number, number, number, number];
  label: ParsedPdfBlockKind;
  confidence?: number;
}
