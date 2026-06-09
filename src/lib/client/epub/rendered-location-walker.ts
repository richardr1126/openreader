import type { Book, Rendition } from 'epubjs';

import { createRangeCfi } from '@/lib/client/epub';
import {
  buildEpubChunkAnchor,
  invalidateSpinePlainTextCache,
} from '@/lib/client/epub/spine-coordinates';
import { buildWalkerThemeRules, type WalkerThemeSnapshot } from '@/lib/client/epub/walker-theme';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

export interface RenderedLocationWalkItem {
  /** Page-start CFI from the rendition. Retained as a soft jump hint only. */
  cfi: string;
  /** Plain-text content of the rendered page chunk. */
  text: string;
  /** Spine item href the chunk belongs to. Stable across viewports. */
  spineHref: string;
  /** Ordinal of the spine item within the book. Stable across viewports. */
  spineIndex: number;
  /**
   * Offset (in normalized character space — see normalizeSegmentIdentityText)
   * where this chunk begins inside the spine item's plain text. Stable across
   * viewports, so segments can be anchored to this base.
   */
  chunkOffset: number;
  /**
   * Canonical segments for this chunk, windowed from the chapter's canonical
   * plan. Attached after the raw walk by `walkUpcomingRenderedLocations` (which
   * holds the live Book). Present means prefetch can use viewport-independent
   * segments that mint identical keys to playback; absent → preview fallback.
   */
  segments?: CanonicalTtsSegment[];
}

export interface RenderedLocationWalkRequest {
  data: ArrayBuffer;
  startCfi: string;
  depth: number;
  signal: AbortSignal;
  width: number;
  height: number;
  spread?: string;
  theme?: WalkerThemeSnapshot | null;
}

type Session = {
  key: string;
  host: HTMLDivElement;
  book: Book;
  rendition: Rendition;
};

type EpubFactory = (input: ArrayBuffer, options?: { openAs?: string }) => Book;

const MAX_BACKOFF_MS = 3_000;
const BACKOFF_BASE_MS = 250;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const normalizeCfiKey = (cfi: string): string =>
  cfi
    .trim()
    .replace(/\[;s=[ab]\]/gi, '')
    .replace(/\s+/g, '');

const createAbortPromise = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });

function resolveEpubFactory(moduleValue: unknown): EpubFactory {
  const candidate = (moduleValue as { default?: unknown; ePub?: unknown }).default
    ?? (moduleValue as { ePub?: unknown }).ePub
    ?? moduleValue;
  if (typeof candidate !== 'function') {
    throw new Error('Failed to resolve epubjs factory function');
  }
  return candidate as EpubFactory;
}

export class EpubRenderedLocationCloneManager {
  private queue: Promise<void> = Promise.resolve();
  private activeSession: Session | null = null;
  private modulePromise: Promise<EpubFactory> | null = null;
  private failures = 0;
  private backoffUntilMs = 0;
  private generation = 0;
  private docIds = new WeakMap<ArrayBuffer, number>();
  private nextDocId = 1;

  private docIdFor(buffer: ArrayBuffer): number {
    const existing = this.docIds.get(buffer);
    if (existing) return existing;
    const next = this.nextDocId;
    this.nextDocId += 1;
    this.docIds.set(buffer, next);
    return next;
  }

  private buildSessionKey(request: RenderedLocationWalkRequest): string {
    const themeSig = request.theme
      ? `${request.theme.foreground}|${request.theme.base}`
      : 'none';
    return [
      `doc:${this.docIdFor(request.data)}`,
      `w:${Math.floor(request.width)}`,
      `h:${Math.floor(request.height)}`,
      `s:${request.spread || 'auto'}`,
      `t:${themeSig}`,
    ].join('|');
  }

  private async getFactory(): Promise<EpubFactory> {
    if (!this.modulePromise) {
      this.modulePromise = import('epubjs').then((moduleValue) => resolveEpubFactory(moduleValue));
    }
    return this.modulePromise;
  }

  private noteFailure(): void {
    this.failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * (2 ** Math.max(0, this.failures - 1)));
    this.backoffUntilMs = Date.now() + delay;
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.backoffUntilMs = 0;
  }

  invalidate(): void {
    this.generation += 1;
    this.noteSuccess();
    void this.enqueue(async () => {
      await this.resetSession();
    });
  }

  async destroy(): Promise<void> {
    this.generation += 1;
    this.noteSuccess();
    await this.enqueue(async () => {
      await this.resetSession();
    });
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async resetSession(): Promise<void> {
    const current = this.activeSession;
    this.activeSession = null;
    if (!current) return;
    try {
      invalidateSpinePlainTextCache(current.book);
    } catch {}
    try {
      current.rendition.destroy();
    } catch {}
    try {
      current.book.destroy();
    } catch {}
    try {
      current.host.remove();
    } catch {}
  }

  private async ensureSession(
    request: RenderedLocationWalkRequest,
    abortPromise: Promise<never>,
  ): Promise<Session> {
    const key = this.buildSessionKey(request);
    if (this.activeSession?.key === key) {
      return this.activeSession;
    }

    await this.resetSession();

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.width = `${Math.max(320, Math.floor(request.width))}px`;
    host.style.height = `${Math.max(320, Math.floor(request.height))}px`;
    host.style.opacity = '0';
    host.style.pointerEvents = 'none';
    host.style.overflow = 'hidden';
    document.body.appendChild(host);

    let book: Book | null = null;
    try {
      const createBook = await Promise.race([this.getFactory(), abortPromise]);
      const clonedData = request.data.slice(0);
      // ArrayBuffer input must use binary auto-detection; forcing openAs:'epub'
      // treats the payload like a URL/path and can break packaging metadata.
      book = createBook(clonedData);

      await Promise.race([book.ready, abortPromise]);

      const rendition = book.renderTo(host, {
        width: Math.max(320, Math.floor(request.width)),
        height: Math.max(320, Math.floor(request.height)),
        manager: 'default',
        flow: 'paginated',
        spread: request.spread,
        allowScriptedContent: false,
      });

      if (request.theme) {
        try {
          rendition.themes.registerRules('openreader-preload-theme', buildWalkerThemeRules(request.theme));
          rendition.themes.select('openreader-preload-theme');
        } catch (error) {
          console.warn('Failed applying preload EPUB theme rules:', error);
        }
      }

      const session: Session = {
        key,
        host,
        book,
        rendition,
      };
      this.activeSession = session;
      return session;
    } catch (error) {
      try {
        book?.destroy();
      } catch {}
      host.remove();
      throw error;
    }
  }

  private async walkWithSession(
    session: Session,
    request: RenderedLocationWalkRequest,
    abortPromise: Promise<never>,
  ): Promise<RenderedLocationWalkItem[]> {
    const results: RenderedLocationWalkItem[] = [];
    const seen = new Set<string>();
    const anchor = normalizeCfiKey(request.startCfi);
    await Promise.race([session.rendition.display(request.startCfi), abortPromise]);

    let attempts = 0;
    while (results.length < request.depth && attempts < request.depth + 3) {
      attempts += 1;
      if (request.signal.aborted) break;
      try {
        await Promise.race([session.rendition.next(), abortPromise]);
      } catch {
        break;
      }

      const location = (session.rendition.location
        ?? await Promise.resolve(session.rendition.currentLocation())) as {
          start?: { cfi?: string };
          end?: { cfi?: string };
        } | undefined;

      const start = location?.start?.cfi || '';
      const end = location?.end?.cfi || '';
      if (normalizeCfiKey(start) === anchor) {
        // Some renditions report the original displayed location on the first
        // next() tick. Skip it so depth preloads always target upcoming pages.
        continue;
      }
      if (!start || !end || seen.has(start)) continue;
      seen.add(start);

      const rangeCfi = createRangeCfi(start, end);
      const range = await Promise.race([session.book.getRange(rangeCfi), abortPromise]);
      const text = range?.toString()?.trim() || '';
      if (!text) continue;

      const chunkAnchor = await Promise.race([
        buildEpubChunkAnchor(session.book, start, text),
        abortPromise,
      ]);
      if (!chunkAnchor) continue;

      results.push({
        cfi: start,
        text,
        spineHref: chunkAnchor.spineHref,
        spineIndex: chunkAnchor.spineIndex,
        chunkOffset: chunkAnchor.charOffset,
      });
    }

    return results;
  }

  async walk(request: RenderedLocationWalkRequest): Promise<RenderedLocationWalkItem[]> {
    if (!request.startCfi || request.depth <= 0 || request.signal.aborted || typeof document === 'undefined') {
      return [];
    }
    if (Date.now() < this.backoffUntilMs) {
      return [];
    }

    const generationAtStart = this.generation;
    const abortPromise = createAbortPromise(request.signal);

    return this.enqueue(async () => {
      if (generationAtStart !== this.generation || request.signal.aborted) return [];
      try {
        const session = await this.ensureSession(request, abortPromise);
        const items = await this.walkWithSession(session, request, abortPromise);
        if (generationAtStart !== this.generation) return [];
        this.noteSuccess();
        return items;
      } catch (error) {
        if (!isAbortError(error)) {
          this.noteFailure();
          await this.resetSession();
          console.warn('Failed walking upcoming rendered EPUB locations:', error);
        }
        return [];
      }
    });
  }
}
