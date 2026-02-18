'use client';

import { useParams, useRouter } from "next/navigation";
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHTML } from '@/contexts/HTMLContext';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { resolveDocumentId } from '@/lib/client/dexie';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';

export default function HTMLPage() {
  const { id } = useParams();
  const router = useRouter();
  const { setCurrentDocument, currDocName, clearCurrDoc } = useHTML();
  const { stop } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [id]);

  const loadDocument = useCallback(async () => {
    if (!isLoading) return;
    console.log('Loading new HTML document (from page.tsx)');
    let didRedirect = false;
    let startedLoad = false;
    try {
      if (!id) {
        setError('Document not found');
        return;
      }
      const resolved = await resolveDocumentId(id as string);
      if (resolved !== (id as string)) {
        didRedirect = true;
        router.replace(`/html/${resolved}`);
        return;
      }

      if (loadedDocIdRef.current === resolved) {
        return;
      }
      if (inFlightDocIdRef.current === resolved) {
        return;
      }

      startedLoad = true;
      inFlightDocIdRef.current = resolved;
      stop();
      await setCurrentDocument(resolved);
      loadedDocIdRef.current = resolved;
    } catch (err) {
      console.error('Error loading document:', err);
      setError('Failed to load document');
    } finally {
      if (startedLoad) {
        inFlightDocIdRef.current = null;
      }
      if (!didRedirect && startedLoad) {
        setIsLoading(false);
      }
    }
  }, [isLoading, id, router, setCurrentDocument, stop]);

  useEffect(() => {
    if (!isLoading) return;
    loadDocument();
  }, [loadDocument, isLoading]);

  // Compute available height = viewport - (header height + tts bar height)
  useEffect(() => {
    const compute = () => {
      const header = document.querySelector('[data-app-header]') as HTMLElement | null;
      const ttsbar = document.querySelector('[data-app-ttsbar]') as HTMLElement | null;
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const ttsH = ttsbar ? ttsbar.getBoundingClientRect().height : 0;
      const vh = window.innerHeight;
      const h = Math.max(0, vh - headerH - ttsH);
      setContainerHeight(`${h}px`);

      // Adaptive minimum content width: allow some padding on narrow screens
      const vw = window.innerWidth;
      const desiredMin = 640;
      const minContent = Math.min(desiredMin, Math.max(320, vw - 32));
      const maxPad = Math.max(0, Math.floor((vw - minContent) / 2));
      setMaxPadPx(maxPad);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-red-500 mb-4">{error}</p>
        <Link
          href="/app"
          onClick={() => { clearCurrDoc(); }}
          className="inline-flex items-center px-3 py-1 bg-base text-foreground rounded-lg hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Documents
        </Link>
      </div>
    );
  }

  return (
    <>
      <Header
        left={
          <Link
            href="/app"
            onClick={() => clearCurrDoc()}
            className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
            aria-label="Back to documents"
          >
            <svg className="w-3 h-3 mr-2" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Documents
          </Link>
        }
        title={isLoading ? 'Loading…' : (currDocName || '')}
        right={
          <div className="flex items-center gap-3">
            <DocumentHeaderMenu
              zoomLevel={padPct}
              onZoomIncrease={() => setPadPct(p => Math.min(p + 10, 100))}
              onZoomDecrease={() => setPadPct(p => Math.max(p - 10, 0))}
              onOpenSettings={() => setIsSettingsOpen(true)}
              minZoom={0}
              maxZoom={100}
            />
          </div>
        }
      />
      <div className="overflow-hidden" style={{ height: containerHeight }}>
        {isLoading ? (
          <div className="p-4">
            <DocumentSkeleton />
          </div>
        ) : (
          <div className="h-full w-full" style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}>
            <HTMLViewer className="h-full" />
          </div>
        )}
      </div>
      {isAtLimit ? (
        <div className="sticky bottom-0 z-30 w-full border-t border-offbase bg-base" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-1.5 flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : (
        <TTSPlayer />
      )}
      <DocumentSettings html isOpen={isSettingsOpen} setIsOpen={setIsSettingsOpen} />
    </>
  );
}
