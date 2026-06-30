'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTTS } from '@/contexts/TTSContext';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { buildHtmlDocumentText, parseHtmlBlocks, type HtmlBlock } from '@openreader/tts/html-blocks';
import type { BaseDocument } from '@/types/documents';

export interface HtmlDocumentState {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  isPlaybackReady: boolean;
  blocks: HtmlBlock[];
  isTxt: boolean;
  setCurrentDocument: (metadata: BaseDocument) => Promise<void>;
  clearCurrDoc: () => void;
}

function isTxtName(name: string | undefined | null): boolean {
  return !!name && name.toLowerCase().endsWith('.txt');
}

export function useHtmlDocument(): HtmlDocumentState {
  const { setDocumentPlaybackAnchor, stop, setIsEPUB } = useTTS();

  const [currDocData, setCurrDocData] = useState<string>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);

  const isTxt = useMemo(() => isTxtName(currDocName), [currDocName]);
  const blocks = useMemo(
    () => (currDocData !== undefined ? parseHtmlBlocks(currDocData, isTxt) : []),
    [currDocData, isTxt],
  );

  const currDocText = useMemo(() => buildHtmlDocumentText(blocks), [blocks]);

  // HTML reader is not an EPUB reader.
  useEffect(() => {
    setIsEPUB(false);
  }, [setIsEPUB]);

  // Feed the entire document into TTS once it's parsed. The TTS context owns
  // sentence splitting + sequential advancement from there.
  const lastFedDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (currDocData === undefined) {
      lastFedDocRef.current = null;
      setDocumentPlaybackAnchor(1, false);
      setIsPlaybackReady(false);
      return;
    }
    if (!currDocText) {
      lastFedDocRef.current = null;
      setDocumentPlaybackAnchor(1, false);
      setIsPlaybackReady(true);
      return;
    }
    const key = `${currDocName ?? ''}::${currDocData ?? ''}::${currDocText.length}`;
    if (lastFedDocRef.current === key) {
      setIsPlaybackReady(true);
      return;
    }
    setIsPlaybackReady(false);
    lastFedDocRef.current = key;
    setDocumentPlaybackAnchor(1, true, { readerType: 'html', location: '1' });
    setIsPlaybackReady(true);
  }, [currDocName, currDocText, currDocData, setDocumentPlaybackAnchor]);

  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setIsPlaybackReady(false);
    lastFedDocRef.current = null;
    setDocumentPlaybackAnchor(1, false);
    stop();
  }, [setDocumentPlaybackAnchor, stop]);

  const setCurrentDocument = useCallback(async (meta: BaseDocument): Promise<void> => {
    try {
      setIsPlaybackReady(false);
      lastFedDocRef.current = null;
      setDocumentPlaybackAnchor(1, false);
      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'html') {
        // Throw so the catch handler clears stale reader state instead of
        // leaving the previous document visible after a mismatched navigation.
        throw new Error('Document is not an HTML/TXT/MD document');
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data);
    } catch (error) {
      console.error('Failed to get HTML document:', error);
      clearCurrDoc();
      throw error;
    }
  }, [clearCurrDoc, setDocumentPlaybackAnchor]);

  return useMemo(
    () => ({
      currDocData,
      currDocName,
      currDocText,
      isPlaybackReady,
      blocks,
      isTxt,
      setCurrentDocument,
      clearCurrDoc,
    }),
    [
      currDocData,
      currDocName,
      currDocText,
      isPlaybackReady,
      blocks,
      isTxt,
      setCurrentDocument,
      clearCurrDoc,
    ],
  );
}
