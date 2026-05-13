'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTTS } from '@/contexts/TTSContext';
import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';

interface HtmlDocumentState {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
}

export function useHtmlDocument(): HtmlDocumentState {
  const { setText: setTTSText, stop } = useTTS();
  const setTTSTextRef = useRef(setTTSText);

  const [currDocData, setCurrDocData] = useState<string>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();

  useEffect(() => {
    setTTSTextRef.current = setTTSText;
  }, [setTTSText]);

  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setCurrDocText(undefined);
    stop();
  }, [stop]);

  const setCurrentDocument = useCallback(async (id: string): Promise<void> => {
    try {
      const meta = await getDocumentMetadata(id);
      if (!meta) {
        console.error('Document not found on server');
        return;
      }

      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'html') {
        console.error('Document is not an HTML/TXT/MD document');
        return;
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data);
      setCurrDocText(doc.data);
      setTTSTextRef.current(doc.data);
    } catch (error) {
      console.error('Failed to get HTML document:', error);
      clearCurrDoc();
    }
  }, [clearCurrDoc]);

  return useMemo(
    () => ({
      currDocData,
      currDocName,
      currDocText,
      setCurrentDocument,
      clearCurrDoc,
    }),
    [currDocData, currDocName, currDocText, setCurrentDocument, clearCurrDoc],
  );
}
