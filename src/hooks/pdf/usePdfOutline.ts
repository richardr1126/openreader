'use client';

import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OutlineEntry } from '@/lib/client/reader/chapters';

type PdfOutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

async function pageOfDestination(pdf: PDFDocumentProxy, dest: PdfOutlineNode['dest']): Promise<number | null> {
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  const ref = Array.isArray(explicit) ? explicit[0] : null;
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'number') return ref + 1;
  return (await pdf.getPageIndex(ref)) + 1;
}

/**
 * The PDF's own outline (bookmarks) as reader outline entries, or an empty
 * outline when the file has none, its destinations do not resolve, or pdf.js
 * is not loaded (the plain-text reading mode).
 */
export function usePdfOutline(pdf: PDFDocumentProxy | undefined): OutlineEntry[] {
  const [outline, setOutline] = useState<OutlineEntry[]>([]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const load = async () => {
      const entries: OutlineEntry[] = [];
      const visit = async (nodes: readonly PdfOutlineNode[], depth: number) => {
        for (const node of nodes) {
          const page = await pageOfDestination(pdf, node.dest).catch(() => null);
          if (page !== null && node.title?.trim()) {
            entries.push({ title: node.title.trim(), target: { readerType: 'pdf', page }, depth });
          }
          if (node.items?.length) await visit(node.items, depth + 1);
        }
      };
      const root = await pdf.getOutline();
      await visit(root ?? [], 0);
      if (!cancelled) setOutline(entries);
    };
    load().catch((error) => {
      console.warn('Failed to read the PDF outline:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  return outline;
}
