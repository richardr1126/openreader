import path from 'path';
import type { DocumentType } from '@/types/documents';

export function safeDocumentName(rawName: string, fallback: string): string {
  const baseName = path.basename(rawName || fallback);
  return baseName.replaceAll('\u0000', '').slice(0, 240) || fallback;
}

export function toDocumentTypeFromName(name: string): DocumentType {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.docx') return 'docx';
  return 'html';
}
