'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useTTS } from '@/contexts/TTSContext';
import { buildHtmlDocumentText, parseHtmlBlocks, type HtmlBlock } from '@openreader/tts/html-blocks';
import type { HTMLDocument } from '@/types/documents';

export interface HtmlDocumentState {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  isPlaybackReady: boolean;
  blocks: HtmlBlock[];
  isTxt: boolean;
}

function isTxtName(name: string | undefined | null): boolean {
  return !!name && name.toLowerCase().endsWith('.txt');
}

export function useHtmlDocument(document: HTMLDocument): HtmlDocumentState {
  const { setDocumentPlaybackAnchor } = useTTS();

  const currDocData = document.data;
  const currDocName = document.name;
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);

  const isTxt = useMemo(() => isTxtName(currDocName), [currDocName]);
  const blocks = useMemo(
    () => (currDocData !== undefined ? parseHtmlBlocks(currDocData, isTxt) : []),
    [currDocData, isTxt],
  );

  const currDocText = useMemo(() => buildHtmlDocumentText(blocks), [blocks]);

  // Feed the entire document into TTS once it's parsed. The TTS context owns
  // sentence splitting + sequential advancement from there.
  const lastFedDocRef = useRef<string | null>(null);
  useEffect(() => {
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

  return useMemo(
    () => ({
      currDocData,
      currDocName,
      currDocText,
      isPlaybackReady,
      blocks,
      isTxt,
    }),
    [
      currDocData,
      currDocName,
      currDocText,
      isPlaybackReady,
      blocks,
      isTxt,
    ],
  );
}
