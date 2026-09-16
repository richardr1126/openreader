import { DocumentListDocument } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getDocumentContentSnippet,
  getDocumentPreviewStatus,
  subscribeDocumentPreviewEvents,
  type DocumentPreviewReady,
} from '@/lib/client/api/documents';
import {
  getInMemoryDocumentPreviewUrl,
  peekDocumentPreviewUrl,
  primeDocumentPreviewCache,
  setInMemoryDocumentPreviewUrl,
} from '@/lib/client/cache/previews';
import { formatDocumentSize } from './formatSize';
import { queryKeys } from '@/lib/client/query-keys';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocumentPreviewProps {
  doc: DocumentListDocument;
}

type CachedPreview = {
  imagePreview: string | null;
  textPreview: string | null;
};

type PreviewState = CachedPreview & {
  key: string;
};

const MAX_TEXT_PREVIEW_CACHE = 100;
const textPreviewCache = new Map<string, string>();

/** Read from cache and promote entry to most-recently-used. */
function textPreviewCacheGet(key: string): string | undefined {
  const value = textPreviewCache.get(key);
  if (value !== undefined) {
    // Re-insert to move to end (most-recently-used)
    textPreviewCache.delete(key);
    textPreviewCache.set(key, value);
  }
  return value;
}

/** Write to cache, evicting the least-recently-used entry when over the cap. */
function textPreviewCacheSet(key: string, value: string): void {
  // If the key already exists, delete first so re-insertion moves it to the end
  if (textPreviewCache.has(key)) {
    textPreviewCache.delete(key);
  }
  textPreviewCache.set(key, value);
  if (textPreviewCache.size > MAX_TEXT_PREVIEW_CACHE) {
    // Map keys iterate in insertion order; first key is the LRU entry
    const oldest = textPreviewCache.keys().next().value;
    if (oldest !== undefined) textPreviewCache.delete(oldest);
  }
}

export function DocumentPreview({ doc }: DocumentPreviewProps) {
  const isPDF = doc.type === 'pdf';
  const isEPUB = doc.type === 'epub';
  const isHTML = doc.type === 'html';
  const lowerName = doc.name.toLowerCase();
  const isTxtFile = isHTML && lowerName.endsWith('.txt');
  const isMarkdownFile =
    isHTML &&
    (lowerName.endsWith('.md') ||
      lowerName.endsWith('.markdown') ||
      lowerName.endsWith('.mdown') ||
      lowerName.endsWith('.mkd'));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Guards a single re-resolve after an image load error (e.g. an expired
  // presigned URL), reset whenever the preview identity changes.
  const previewErrorRetriedRef = useRef(false);
  const queryClient = useQueryClient();
  const [isVisible, setIsVisible] = useState(false);
  const previewKey = useMemo(
    () => `${doc.type}:${doc.id}:${Number(doc.lastModified)}`,
    [doc.id, doc.lastModified, doc.type],
  );
  const previewQueryKey = useMemo(
    () => queryKeys.documentPreview(doc.id, doc.type, Number(doc.lastModified)),
    [doc.id, doc.lastModified, doc.type],
  );
  const cachedPreview = queryClient.getQueryData<CachedPreview>(previewQueryKey);
  const [previewState, setPreviewState] = useState<PreviewState>(() => ({
    key: previewKey,
    imagePreview: cachedPreview?.imagePreview ?? getInMemoryDocumentPreviewUrl(previewKey),
    textPreview: cachedPreview?.textPreview ?? textPreviewCacheGet(previewKey) ?? null,
  }));
  const imagePreview = previewState.key === previewKey ? previewState.imagePreview : null;
  const textPreview = previewState.key === previewKey ? previewState.textPreview : null;
  const setImagePreview = useCallback((value: string | null) => {
    setPreviewState((previous) => previous.key === previewKey
      ? { ...previous, imagePreview: value }
      : previous);
  }, [previewKey]);
  const setTextPreview = useCallback((value: string | null) => {
    setPreviewState((previous) => previous.key === previewKey
      ? { ...previous, textPreview: value }
      : previous);
  }, [previewKey]);
  const [isImageReady, setIsImageReady] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    const cached = queryClient.getQueryData<CachedPreview>(previewQueryKey);
    setPreviewState({
      key: previewKey,
      imagePreview: cached?.imagePreview ?? getInMemoryDocumentPreviewUrl(previewKey),
      textPreview: cached?.textPreview ?? textPreviewCacheGet(previewKey) ?? null,
    });
    setIsImageReady(false);
    setIsGenerating(false);
    previewErrorRetriedRef.current = false;
  }, [previewKey, previewQueryKey, queryClient]);

  useEffect(() => {
    if (previewState.key !== previewKey) return;
    if (!previewState.imagePreview && !previewState.textPreview) return;
    queryClient.setQueryData<CachedPreview>(previewQueryKey, {
      imagePreview: previewState.imagePreview,
      textPreview: previewState.textPreview,
    });
  }, [previewKey, previewQueryKey, previewState, queryClient]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setIsVisible(true);
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;

    const cachedImage = getInMemoryDocumentPreviewUrl(previewKey);
    if (cachedImage) {
      setImagePreview(cachedImage);
      setTextPreview(null);
      return;
    }

    const cachedText = textPreviewCacheGet(previewKey);
    if (cachedText) {
      setTextPreview(cachedText);
      setImagePreview(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let closePreviewEvents: (() => void) | null = null;

    const applyReadyPreview = async (status: DocumentPreviewReady) => {
      // Presigned transport: render straight from the S3 URL so the image load
      // never hits the Vercel presign route, and cache it so remounts/scroll-back
      // reuse the same URL for the life of its (now 1h) signature.
      if (status.directUrl) {
        setInMemoryDocumentPreviewUrl(previewKey, status.directUrl);
        setImagePreview(status.directUrl);
        setTextPreview(null);
        return;
      }

      // Proxy transport: fetch the image bytes once and persist them in Cache
      // Storage keyed by preview version.
      const primedUrl = await primeDocumentPreviewCache(
        doc.id,
        status.previewVersion || Number(doc.lastModified),
        previewKey,
        { signal: controller.signal },
      ).catch(() => null);
      if (cancelled) return;

      if (primedUrl) {
        setImagePreview(primedUrl);
        setTextPreview(null);
        return;
      }

      setInMemoryDocumentPreviewUrl(previewKey, status.presignUrl);
      setImagePreview(status.presignUrl);
      setTextPreview(null);
    };

    const run = async () => {
      setIsGenerating(true);
      let keepGeneratingForEvents = false;
      try {
        if (doc.type === 'pdf' || doc.type === 'epub') {
          // Warm-cache fast path only — never fetches, so a cold preview in
          // presigned mode doesn't fire a doomed request at the proxy route.
          const persistedUrl = await peekDocumentPreviewUrl(
            doc.id,
            Number(doc.lastModified),
            previewKey,
          );
          if (!cancelled && persistedUrl) {
            setImagePreview(persistedUrl);
            setTextPreview(null);
            return;
          }

          const status = await getDocumentPreviewStatus(doc.id, { signal: controller.signal });
          if (cancelled) return;

          if (status.kind === 'ready') {
            await applyReadyPreview(status);
            return;
          }

          if (status.status === 'failed' || !status.opId) {
            return;
          }

          closePreviewEvents = subscribeDocumentPreviewEvents(
            doc.id,
            { opId: status.opId },
            {
              onSnapshot: (snapshot) => {
                if (cancelled) return;
                if (snapshot.status === 'failed') {
                  closePreviewEvents?.();
                  closePreviewEvents = null;
                  setIsGenerating(false);
                  return;
                }
                if (snapshot.status !== 'ready') return;

                closePreviewEvents?.();
                closePreviewEvents = null;
                void (async () => {
                  try {
                    const refreshed = await getDocumentPreviewStatus(doc.id, { signal: controller.signal });
                    if (cancelled) return;
                    if (refreshed.kind === 'ready') {
                      await applyReadyPreview(refreshed);
                    }
                  } catch {
                    // fall back to icon
                  } finally {
                    if (!cancelled) {
                      setIsGenerating(false);
                    }
                  }
                })();
              },
            },
          );
          keepGeneratingForEvents = true;
          return;
        }

        if (doc.type === 'html') {
          const snippet = await getDocumentContentSnippet(doc.id, {
            maxChars: 1600,
            maxBytes: 128 * 1024,
            signal: controller.signal,
          });
          if (cancelled) return;
          textPreviewCacheSet(previewKey, snippet);
          setTextPreview(snippet);
          setImagePreview(null);
          return;
        }
      } catch {
        // fall back to icon
      } finally {
        if (!cancelled && !keepGeneratingForEvents) {
          setIsGenerating(false);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
      closePreviewEvents?.();
      controller.abort();
    };
  }, [doc.id, doc.lastModified, doc.type, isVisible, previewKey, setImagePreview, setTextPreview]);

  useEffect(() => {
    setIsImageReady(false);
  }, [imagePreview]);

  // Cached blob/http sources can already be decoded before React's onLoad handler
  // runs on remount, leaving opacity at 0. Promote already-complete images.
  useEffect(() => {
    if (!imagePreview) return;
    const img = imageRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      setIsImageReady(true);
    }
  }, [imagePreview]);

  const gradientClass = isPDF
    ? 'from-red-500/80 via-red-400/60 to-red-600/80'
    : isEPUB
      ? 'from-blue-500/80 via-blue-400/60 to-blue-600/80'
      : isHTML
        ? 'from-violet-500/80 via-violet-400/60 to-violet-600/80'
        : 'from-slate-500/80 via-slate-400/60 to-slate-600/80';

  const Icon = isPDF ? PDFIcon : isEPUB ? EPUBIcon : FileIcon;

  const typeLabel = isPDF
    ? 'PDF'
    : isEPUB
      ? 'EPUB'
      : isHTML
        ? isTxtFile
          ? 'TXT'
          : isMarkdownFile
            ? 'MD'
            : 'TEXT'
        : 'FILE';

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-[3/4] overflow-hidden rounded-t-md bg-surface"
    >
      {imagePreview ? (
        <>
          <div className={`absolute inset-0 bg-gradient-to-br ${gradientClass}`} />
          {!isImageReady ? (
            <div className="relative z-10 flex flex-col items-center justify-center h-full gap-2 px-2 text-white">
              <Icon className="w-10 h-10 sm:w-12 sm:h-12 drop-shadow-md" />
              <span className="text-[10px] sm:text-[11px] tracking-wide uppercase font-semibold opacity-90">
                {typeLabel}
              </span>
            </div>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={imagePreview}
            alt={`${doc.name} preview`}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-fast ${isImageReady ? 'opacity-100' : 'opacity-0'}`}
            draggable={false}
            loading="lazy"
            onLoad={() => {
              setIsImageReady(true);
            }}
            onError={() => {
              if (!imagePreview) return;
              setIsImageReady(false);
              // A cached presigned S3 URL may have expired; re-resolve it once
              // via the status endpoint rather than looping on the same URL.
              if (previewErrorRetriedRef.current) return;
              previewErrorRetriedRef.current = true;
              void getDocumentPreviewStatus(doc.id)
                .then((status) => {
                  if (status.kind !== 'ready') return;
                  const nextUrl = status.directUrl || status.presignUrl;
                  setInMemoryDocumentPreviewUrl(previewKey, nextUrl);
                  setImagePreview(nextUrl);
                })
                .catch(() => { });
            }}
          />
          {isImageReady ? <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/15" /> : null}
        </>
      ) : textPreview ? (
        <>
          <div className="absolute inset-0 bg-gradient-to-br from-surface-solid to-surface-sunken" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px)',
              backgroundSize: '12px 12px',
              opacity: 0.35,
              WebkitMaskImage: 'radial-gradient(120% 100% at 50% 40%, #000 55%, transparent 100%)',
              maskImage: 'radial-gradient(120% 100% at 50% 40%, #000 55%, transparent 100%)',
            }}
          />
          <div className="relative z-10 h-full w-full p-2 flex flex-col">
            <div className="mb-auto rounded-md bg-surface-solid backdrop-blur-[1px] shadow-elev-1 ring-1 ring-line-soft p-2.5 max-h-[85%] overflow-hidden">
              {isTxtFile ? (
                <pre className="text-[10px] sm:text-[11px] leading-snug text-foreground whitespace-pre-wrap font-mono">
                  {textPreview}
                </pre>
              ) : (
                <div className="text-[10px] sm:text-[11px] leading-snug text-foreground break-words [overflow-wrap:anywhere]">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: (props) => <p className="m-0" {...props} />,
                      h1: (props) => <h1 className="m-0 font-semibold text-[11px]" {...props} />,
                      h2: (props) => <h2 className="m-0 font-semibold text-[11px]" {...props} />,
                      h3: (props) => <h3 className="m-0 font-semibold text-[11px]" {...props} />,
                      h4: (props) => <h4 className="m-0 font-semibold text-[11px]" {...props} />,
                      h5: (props) => <h5 className="m-0 font-semibold text-[11px]" {...props} />,
                      h6: (props) => <h6 className="m-0 font-semibold text-[11px]" {...props} />,
                      ul: (props) => <ul className="m-0 pl-4" {...props} />,
                      ol: (props) => <ol className="m-0 pl-4" {...props} />,
                      li: (props) => <li className="my-0" {...props} />,
                      a: ({ children }) => <span>{children}</span>,
                      img: () => null,
                      blockquote: (props) => (
                        <blockquote className="m-0 pl-2 border-l-2 border-line text-soft" {...props} />
                      ),
                      code: (props) => (
                        <code
                          className="font-mono text-[10px] bg-surface-sunken rounded px-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                          {...props}
                        />
                      ),
                      pre: (props) => (
                        <pre className="m-0 font-mono text-[10px] whitespace-pre-wrap break-words [overflow-wrap:anywhere]" {...props} />
                      ),
                    }}
                  >
                    {textPreview}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className={`absolute inset-0 bg-gradient-to-br ${gradientClass}`} />
          <div className="relative z-10 flex flex-col items-center justify-center h-full gap-2 px-2 text-white">
            <Icon className="w-10 h-10 sm:w-12 sm:h-12 drop-shadow-md" />
            <span className="text-[10px] sm:text-[11px] tracking-wide uppercase font-semibold opacity-90">
              {typeLabel}
            </span>
          </div>
        </>
      )}

      <div className="absolute left-1 bottom-1 z-20 rounded bg-black/45 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-white/90">
        {isGenerating
          ? '…'
          : `${typeLabel} • ${formatDocumentSize(doc.size)}`}
      </div>
    </div>
  );
}
