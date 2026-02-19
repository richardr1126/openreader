'use client';

import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react';
import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { useTTS } from '@/contexts/TTSContext';

interface HTMLContextType {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
}

const HTMLContext = createContext<HTMLContextType | undefined>(undefined);

/**
 * Provider component for HTML/Markdown functionality
 * Manages the state and operations for HTML document handling
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 */
export function HTMLProvider({ children }: { children: ReactNode }) {
  const { setText: setTTSText, stop } = useTTS();
  const setTTSTextRef = useRef(setTTSText);

  // Current document state
  const [currDocData, setCurrDocData] = useState<string>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();

  useEffect(() => {
    setTTSTextRef.current = setTTSText;
  }, [setTTSText]);

  /**
   * Clears all current document state and stops any active TTS
   */
  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setCurrDocText(undefined);
    stop();
  }, [stop]);

  /**
   * Sets the current document based on its ID
   * @param {string} id - The unique identifier of the document
   * @throws {Error} When document data is empty or retrieval fails
   */
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
      setCurrDocText(doc.data); // Use the same text for TTS
      setTTSTextRef.current(doc.data);
    } catch (error) {
      console.error('Failed to get HTML document:', error);
      clearCurrDoc();
    }
  }, [clearCurrDoc]);



  const contextValue = useMemo(() => ({
    currDocData,
    currDocName,
    currDocText,
    setCurrentDocument,
    clearCurrDoc,
  }), [
    currDocData,
    currDocName,
    currDocText,
    setCurrentDocument,
    clearCurrDoc,
  ]);

  return (
    <HTMLContext.Provider value={contextValue}>
      {children}
    </HTMLContext.Provider>
  );
}

/**
 * Custom hook to consume the HTML context
 * @returns {HTMLContextType} The HTML context value
 * @throws {Error} When used outside of HTMLProvider
 */
export function useHTML() {
  const context = useContext(HTMLContext);
  if (context === undefined) {
    throw new Error('useHTML must be used within an HTMLProvider');
  }
  return context;
}
