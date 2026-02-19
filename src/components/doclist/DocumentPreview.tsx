import { DocumentListDocument } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  documentPreviewFallbackUrl,
  getDocumentContentSnippet,
  getDocumentPreviewStatus,
} from '@/lib/client/api/documents';
import {
  getInMemoryDocumentPreviewUrl,
  getPersistedDocumentPreviewUrl,
  primeDocumentPreviewCache,
  setInMemoryDocumentPreviewUrl,
} from '@/lib/client/cache/previews';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocumentPreviewProps {
  doc: DocumentListDocument;
}

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
  const [isVisible, setIsVisible] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isImageReady, setIsImageReady] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const previewKey = useMemo(() => `${doc.type}:${doc.id}`, [doc.id, doc.type]);

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

    const run = async () => {
      setIsGenerating(true);
      try {
        if (doc.type === 'pdf' || doc.type === 'epub') {
          const persistedUrl = await getPersistedDocumentPreviewUrl(
            doc.id,
            Number(doc.lastModified),
            previewKey,
          );
          if (!cancelled && persistedUrl) {
            setImagePreview(persistedUrl);
            setTextPreview(null);
            return;
          }

          let attempt = 0;
          while (!cancelled && attempt < 12) {
            const status = await getDocumentPreviewStatus(doc.id, { signal: controller.signal });
            if (cancelled) return;

            if (status.kind === 'ready') {
              const primedUrl = await primeDocumentPreviewCache(
                doc.id,
                Number(doc.lastModified),
                previewKey,
                { signal: controller.signal },
              ).catch(() => null);
              if (cancelled) return;

              if (primedUrl) {
                setImagePreview(primedUrl);
                setTextPreview(null);
                return;
              }

              const fallbackUrl = status.fallbackUrl || documentPreviewFallbackUrl(doc.id);
              setInMemoryDocumentPreviewUrl(previewKey, fallbackUrl);
              setImagePreview(fallbackUrl);
              setTextPreview(null);
              return;
            }

            if (status.status === 'failed') {
              return;
            }

            const waitMs = Math.max(
              400,
              Math.min(6000, Number.isFinite(status.retryAfterMs) ? status.retryAfterMs : 1500),
            );
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, waitMs);
              controller.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
            attempt += 1;
          }
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
        if (!cancelled) {
          setIsGenerating(false);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [doc.id, doc.lastModified, doc.type, isVisible, previewKey]);

  useEffect(() => {
    setIsImageReady(false);
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
      className="relative w-full aspect-[3/4] overflow-hidden rounded-t-md bg-base"
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
            src={imagePreview}
            alt={`${doc.name} preview`}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${isImageReady ? 'opacity-100' : 'opacity-0'}`}
            draggable={false}
            loading="lazy"
            onLoad={() => {
              setIsImageReady(true);
            }}
            onError={() => {
              if (!imagePreview) return;
              setIsImageReady(false);
              const fallback = documentPreviewFallbackUrl(doc.id);
              if (imagePreview === fallback) return;
              setInMemoryDocumentPreviewUrl(previewKey, fallback);
              setImagePreview(fallback);
              void primeDocumentPreviewCache(
                doc.id,
                Number(doc.lastModified),
                previewKey,
              ).catch(() => { });
            }}
          />
          {isImageReady ? <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/15" /> : null}
        </>
      ) : textPreview ? (
        <>
          <div className="absolute inset-0 bg-gradient-to-br from-slate-50 to-slate-200" />
          <div className="absolute inset-0 opacity-[0.06] bg-[radial-gradient(circle_at_1px_1px,rgba(0,0,0,1)_1px,transparent_0)] [background-size:12px_12px]" />
          <div className="relative z-10 h-full w-full p-2 flex flex-col">
            <div className="mt-auto rounded-md bg-white/70 backdrop-blur-[1px] shadow-sm ring-1 ring-black/5 p-2.5 max-h-[70%] overflow-hidden">
              {isTxtFile ? (
                <pre className="text-[10px] sm:text-[11px] leading-snug text-slate-900 whitespace-pre-wrap font-mono">
                  {textPreview}
                </pre>
              ) : (
                <div className="text-[10px] sm:text-[11px] leading-snug text-slate-900 break-words [overflow-wrap:anywhere]">
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
                        <blockquote className="m-0 pl-2 border-l-2 border-slate-300 text-slate-700" {...props} />
                      ),
                      code: (props) => (
                        <code
                          className="font-mono text-[10px] bg-slate-900/5 rounded px-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
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

      <div className="absolute left-1 top-1 z-20 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">
        {isGenerating ? '…' : typeLabel}
      </div>
    </div>
  );
}
