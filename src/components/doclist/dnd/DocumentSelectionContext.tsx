'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DocumentListDocument } from '@/types/documents';

type DocKey = string; // `${type}-${id}`

const docKey = (doc: Pick<DocumentListDocument, 'id' | 'type'>): DocKey =>
  `${doc.type}-${doc.id}`;

interface SelectionContextValue {
  selection: ReadonlySet<DocKey>;
  isSelected: (doc: Pick<DocumentListDocument, 'id' | 'type'>) => boolean;
  selectionSize: number;
  /** Treat the visible-doc order so shift-click range-select can resolve. */
  setVisibleOrder: (docs: DocumentListDocument[]) => void;
  /** Click semantics: with shift = range-select, with meta/ctrl = toggle, plain = single-select. */
  select: (
    doc: DocumentListDocument,
    opts?: { shift?: boolean; meta?: boolean },
  ) => void;
  clear: () => void;
  /** Force a precise selection (e.g. on drag start when nothing was selected). */
  replace: (docs: DocumentListDocument[]) => void;
  /** Resolve concrete docs for the current selection from the visible-order. */
  getSelectedDocs: () => DocumentListDocument[];
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function DocumentSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Set<DocKey>>(() => new Set());
  const [order, setOrder] = useState<DocumentListDocument[]>([]);
  const [anchor, setAnchor] = useState<DocKey | null>(null);

  const isSelected = useCallback(
    (doc: Pick<DocumentListDocument, 'id' | 'type'>) => selection.has(docKey(doc)),
    [selection],
  );

  const setVisibleOrder = useCallback((docs: DocumentListDocument[]) => {
    setOrder(docs);
  }, []);

  const select = useCallback<SelectionContextValue['select']>(
    (doc, opts) => {
      const key = docKey(doc);
      if (opts?.shift && anchor && order.length > 0) {
        const anchorIdx = order.findIndex((d) => docKey(d) === anchor);
        const targetIdx = order.findIndex((d) => docKey(d) === key);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [lo, hi] =
            anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
          const next = new Set<DocKey>();
          for (let i = lo; i <= hi; i++) next.add(docKey(order[i]));
          setSelection(next);
          return;
        }
      }
      if (opts?.meta) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setAnchor(key);
        return;
      }
      setSelection(new Set([key]));
      setAnchor(key);
    },
    [anchor, order],
  );

  const clear = useCallback(() => {
    setSelection(new Set());
    setAnchor(null);
  }, []);

  const replace = useCallback((docs: DocumentListDocument[]) => {
    const next = new Set<DocKey>();
    for (const d of docs) next.add(docKey(d));
    setSelection(next);
    setAnchor(docs[0] ? docKey(docs[0]) : null);
  }, []);

  const getSelectedDocs = useCallback(() => {
    if (selection.size === 0 || order.length === 0) return [];
    return order.filter((d) => selection.has(docKey(d)));
  }, [selection, order]);

  const value = useMemo<SelectionContextValue>(
    () => ({
      selection,
      isSelected,
      selectionSize: selection.size,
      setVisibleOrder,
      select,
      clear,
      replace,
      getSelectedDocs,
    }),
    [selection, isSelected, setVisibleOrder, select, clear, replace, getSelectedDocs],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useDocumentSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error('useDocumentSelection must be used inside DocumentSelectionProvider');
  }
  return ctx;
}
