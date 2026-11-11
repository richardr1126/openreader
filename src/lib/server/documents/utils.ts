import path from 'path';
import type { DocumentType } from '@/types/documents';

export function safeDocumentName(rawName: string, fallback: string): string {
  const baseName = path.basename(rawName || fallback).replaceAll('\u0000', '');
  if (baseName.length <= 240) return baseName || fallback;
  // A long name is shortened before its extension, which decides the document's type.
  const extension = path.extname(baseName);
  if (extension.length > 16) return baseName.slice(0, 240);
  return `${baseName.slice(0, baseName.length - extension.length).slice(0, 240 - extension.length)}${extension}`;
}

/** Derived from the name so stored content types never depend on what a client declared. */
export function documentContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.epub') return 'application/epub+zip';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/^\.(md|markdown|mdown|mkd)$/.test(ext)) return 'text/markdown; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/** Forces a download on the app origin; uploaded bytes are never rendered there. */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function toDocumentTypeFromName(name: string): DocumentType {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.docx') return 'docx';
  return 'html';
}
