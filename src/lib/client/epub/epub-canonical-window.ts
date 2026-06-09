import type { Book } from 'epubjs';

import {
  findSegmentOffset,
  getSpineItemPlainText,
  resolveSpineFromCfi,
} from '@/lib/client/epub/spine-coordinates';
import {
  buildSegmentKeyPrefix,
  normalizeSegmentIdentityText,
  planCanonicalTtsSegments,
  type CanonicalTtsSegment,
} from '@/lib/shared/tts-segment-plan';
import type { TTSSegmentLocator } from '@/types/client';

/**
 * Canonical "windowing" for EPUB TTS playback.
 *
 * The core invariant: a single EPUB spine item (chapter) is split into TTS
 * segments **exactly once**, with the greedy block grouping fixed from the
 * chapter start. Every rendered viewport page is then a contiguous *window*
 * into that one canonical sequence — selected by character offset, identified
 * by stable ordinal + content key.
 *
 * Viewport pages are **contiguous, non-overlapping** windows into that one
 * canonical sequence: each segment is owned exclusively by the page where its
 * start offset falls (see `selectCanonicalWindow`), exactly like PDF blocks. A
 * block that straddles a page break (starts on page A, ends on page B) is the
 * *same* canonical segment (same key, same ordinal) wherever it is referenced,
 * but it belongs only to page A — page B's window begins at the next segment.
 * This clean partition is what makes the sidebar list and manual skip
 * deterministic and keeps playback from repeating a straddler on the page turn.
 * The playback layer (TTSContext) additionally uses ordinal continuity to hand
 * off to ordinal + 1 across the seam. See `tts-segment-plan.ts` for the planner
 * and `spine-coordinates.ts` for the offset helpers this builds on.
 */

export interface SpinePlanParams {
  spineHref: string;
  spineIndex: number;
  keyPrefix?: string;
  maxBlockLength?: number;
  language?: string;
}

export interface CanonicalWindowResult {
  spineHref: string;
  spineIndex: number;
  /**
   * Segments overlapping the viewport, with each segment's `ownerLocator`
   * rewritten to carry its own per-segment `charOffset` (and the page-start
   * `cfi` as a soft jump hint). Cloned — the cached plan is never mutated.
   */
  segments: CanonicalTtsSegment[];
  /** Global ordinal of the first segment in `segments`. */
  windowStartOrdinal: number;
  /** Global ordinal of the last segment in `segments`. */
  windowEndOrdinal: number;
  /** The full, pristine per-chapter canonical plan (shared reference, do not mutate). */
  plan: CanonicalTtsSegment[];
}

/**
 * Plan one spine item's full text into canonical segments. Pure/sync — the
 * single source of truth shared by playback windowing, the sidebar, and
 * persistence canonicalization so all three mint identical segment keys.
 */
export function planSpineSegments(input: {
  spineText: string;
  spineHref: string;
  spineIndex: number;
  keyPrefix?: string;
  maxBlockLength?: number;
  language?: string;
}): CanonicalTtsSegment[] {
  if (!input.spineText.trim() || !input.spineHref.trim()) return [];

  const sourceKey = `spine:${input.spineIndex}:${input.spineHref}`;
  const keyPrefix = input.keyPrefix ?? buildSegmentKeyPrefix('document', 'epub');
  const plan = planCanonicalTtsSegments(
    [{
      sourceKey,
      text: input.spineText,
      locator: {
        readerType: 'epub',
        spineHref: input.spineHref,
        spineIndex: input.spineIndex,
        charOffset: 0,
      },
    }],
    {
      readerType: 'epub',
      maxBlockLength: input.maxBlockLength,
      keyPrefix,
      language: input.language,
    },
  );
  return plan.segments;
}

// Per-Book cache of fully-planned chapters. Keyed by spine identity + the
// settings that affect segmentation, so a settings change never reuses a stale
// plan. GC'd automatically with the Book instance (WeakMap).
const PLAN_CACHE = new WeakMap<Book, Map<string, CanonicalTtsSegment[]>>();

const planCacheKey = (p: SpinePlanParams): string =>
  `${p.spineIndex}:${p.spineHref}|mbl=${p.maxBlockLength ?? ''}|lang=${p.language ?? ''}|kp=${p.keyPrefix ?? ''}`;

/**
 * Build (or reuse) the cached canonical plan for one spine item. The plan is
 * computed once per (chapter, settings) so within-chapter page turns cost only
 * the windowing step, not a full re-split of the chapter.
 */
export async function buildSpineCanonicalPlan(
  book: Book,
  params: SpinePlanParams,
): Promise<CanonicalTtsSegment[]> {
  let bucket = PLAN_CACHE.get(book);
  if (!bucket) {
    bucket = new Map();
    PLAN_CACHE.set(book, bucket);
  }
  const key = planCacheKey(params);
  const cached = bucket.get(key);
  if (cached) return cached;

  const spineText = await getSpineItemPlainText(book, params.spineHref);
  const segments = planSpineSegments({
    spineText,
    spineHref: params.spineHref,
    spineIndex: params.spineIndex,
    keyPrefix: params.keyPrefix,
    maxBlockLength: params.maxBlockLength,
    language: params.language,
  });
  bucket.set(key, segments);
  return segments;
}

// Slack (in normalized chars) for snapping the window start to a segment
// boundary, absorbing tiny measurement jitter between independently measured
// adjacent-page offsets. Far smaller than a block, so a straddler (whose head
// on the previous page is substantial) is never pulled back in.
const WINDOW_START_SNAP_TOLERANCE = 8;

/**
 * Select the canonical segments that **belong to** the page spanning the
 * character range [startOffset, endOffset). Returns inclusive array-index
 * bounds, or null when the range falls outside the plan.
 *
 * A block belongs to the page where it **starts** — exactly like PDF blocks.
 * This yields a clean, non-overlapping partition of the chapter across pages:
 *
 *  - Start: the first segment that begins at/after `startOffset` (minus a small
 *    snap tolerance). A block straddling *in* from the previous page begins
 *    before `startOffset`, so it is excluded here — it belongs to the previous
 *    page and is never duplicated on this one.
 *  - End: the last segment that begins before `endOffset`. A block straddling
 *    *out* to the next page begins on this page, so it is kept here (and
 *    excluded from the next page by the same start rule).
 *
 * Because both the sidebar and manual skip read this exact list, navigation is
 * deterministic and a block is highlighted as the same segment on every visit.
 */
export function selectCanonicalWindow(
  plan: readonly CanonicalTtsSegment[],
  startOffset: number,
  endOffset: number,
): { startIndex: number; endIndex: number } | null {
  if (plan.length === 0) return null;

  const startThreshold = startOffset - WINDOW_START_SNAP_TOLERANCE;
  let startIndex = -1;
  for (let i = 0; i < plan.length; i += 1) {
    if (plan[i].startAnchor.offset >= startThreshold) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return null; // startOffset is past the end of the chapter

  let endIndex = -1;
  for (let i = plan.length - 1; i >= startIndex; i -= 1) {
    if (plan[i].startAnchor.offset < endOffset) {
      endIndex = i;
      break;
    }
  }
  if (endIndex < startIndex) endIndex = startIndex; // always yield at least one segment

  return { startIndex, endIndex };
}

/**
 * Re-express a segment's anchors relative to a rendered viewport so the EPUB
 * highlight pipeline (resolveVisibleSegmentRange) can map it onto the page's
 * text map. The chapter plan anchors a segment in *spine-global* space
 * (sourceKey = `spine:…`, offset from the chapter start); highlighting needs
 * viewport-local space (sourceKey = the page's rendered-map key, offset within
 * the page text). Offsets are clamped to the page, so a block straddling in/out
 * highlights only its visible portion.
 */
export interface ViewportAnchorContext {
  /** Must equal the rendered text map's sourceKey for this page. */
  sourceKey: string;
  /** Normalized char offset of the page start within the spine text. */
  baseOffset: number;
  /** Normalized length of the page's visible text. */
  length: number;
}

/**
 * Clone a [startIndex, endIndex] slice of a plan, rewriting each segment's
 * `ownerLocator` to a stable per-segment EPUB locator. The per-segment
 * `charOffset` is load-bearing: `buildLocatorRequestKey` keys EPUB audio as
 * `epub:${spineIndex}:${spineHref}:${charOffset}`, and persistence + the
 * sidebar manifest sort rely on a real offset (the planner leaves it 0 for the
 * whole-chapter source unit). `cfi` is attached as a non-identity jump hint.
 *
 * When `viewport` is provided, anchors are additionally rewritten to
 * viewport-local coordinates so the page's segments can be highlighted. Omit it
 * for prefetch/walker slices (not rendered on the current page).
 */
export function materializeWindowSegments(
  plan: readonly CanonicalTtsSegment[],
  startIndex: number,
  endIndex: number,
  ctx: { spineHref: string; spineIndex: number; cfi?: string },
  viewport?: ViewportAnchorContext,
): CanonicalTtsSegment[] {
  const out: CanonicalTtsSegment[] = [];
  const lo = Math.max(0, startIndex);
  const hi = Math.min(plan.length - 1, endIndex);
  const clampToViewport = (offset: number): number =>
    Math.max(0, Math.min(offset - viewport!.baseOffset, viewport!.length));
  for (let i = lo; i <= hi; i += 1) {
    const seg = plan[i];
    const locator: TTSSegmentLocator = {
      readerType: 'epub',
      spineHref: ctx.spineHref,
      spineIndex: ctx.spineIndex,
      charOffset: Math.max(0, seg.startAnchor.offset),
    };
    if (ctx.cfi) locator.cfi = ctx.cfi;
    const next: CanonicalTtsSegment = { ...seg, ownerLocator: locator };
    if (viewport) {
      next.startAnchor = { sourceKey: viewport.sourceKey, offset: clampToViewport(seg.startAnchor.offset) };
      next.endAnchor = { sourceKey: viewport.sourceKey, offset: clampToViewport(seg.endAnchor.offset) };
      // Keep ownerSourceKey in lock-step with the rewritten anchors: the word
      // highlighter (resolveAlignmentWordSourceRange) requires
      // startAnchor.sourceKey === ownerSourceKey to treat the segment as
      // anchored in the rendered page.
      next.ownerSourceKey = viewport.sourceKey;
    }
    out.push(next);
  }
  return out;
}

const buildResult = (
  plan: CanonicalTtsSegment[],
  range: { startIndex: number; endIndex: number },
  ctx: { spineHref: string; spineIndex: number; cfi?: string },
  viewport?: ViewportAnchorContext,
): CanonicalWindowResult | null => {
  const segments = materializeWindowSegments(plan, range.startIndex, range.endIndex, ctx, viewport);
  if (segments.length === 0) return null;
  return {
    spineHref: ctx.spineHref,
    spineIndex: ctx.spineIndex,
    segments,
    windowStartOrdinal: plan[range.startIndex].ordinal,
    windowEndOrdinal: plan[range.endIndex].ordinal,
    plan,
  };
};

export interface BuildEpubCanonicalWindowOptions {
  startCfi: string;
  viewportText: string;
  keyPrefix?: string;
  maxBlockLength?: number;
  language?: string;
  /**
   * Rendered text map sourceKey for this page. When provided, the returned
   * segments' anchors are rewritten to viewport-local coordinates so they can
   * be highlighted (resolveVisibleSegmentRange matches on this sourceKey).
   */
  viewportAnchorSourceKey?: string;
}

/**
 * Foreground path: build the canonical window for the currently rendered page
 * from its start CFI + visible text. Returns null when the page text can't be
 * located in the spine item (footnotes, nav docs, image-only pages) so the
 * caller can fall back to the legacy preview-based plan.
 */
export async function buildEpubCanonicalWindow(
  book: Book | null | undefined,
  options: BuildEpubCanonicalWindowOptions,
): Promise<CanonicalWindowResult | null> {
  if (!book?.isOpen) return null;
  if (!options.viewportText.trim()) return null;

  const spine = resolveSpineFromCfi(book, options.startCfi);
  if (!spine) return null;

  const plan = await buildSpineCanonicalPlan(book, {
    spineHref: spine.href,
    spineIndex: spine.index,
    keyPrefix: options.keyPrefix,
    maxBlockLength: options.maxBlockLength,
    language: options.language,
  });
  if (plan.length === 0) return null;

  const spineText = await getSpineItemPlainText(book, spine.href);
  // Explicit -1 detection — do NOT use buildEpubChunkAnchor here, which masks a
  // miss to offset 0 and would silently window from the chapter start.
  const startOffset = findSegmentOffset(spineText, options.viewportText, 0);
  if (startOffset < 0) return null;
  const viewportLength = normalizeSegmentIdentityText(options.viewportText).length;
  const endOffset = startOffset + viewportLength;

  const range = selectCanonicalWindow(plan, startOffset, endOffset);
  if (!range) return null;
  const viewport: ViewportAnchorContext | undefined = options.viewportAnchorSourceKey
    ? { sourceKey: options.viewportAnchorSourceKey, baseOffset: startOffset, length: viewportLength }
    : undefined;
  return buildResult(plan, range, {
    spineHref: spine.href,
    spineIndex: spine.index,
    cfi: options.startCfi,
  }, viewport);
}

export interface BuildEpubCanonicalWindowFromChunkOptions {
  spineHref: string;
  spineIndex: number;
  /** Chunk start offset in normalized character space (from the walker). */
  chunkOffset: number;
  text: string;
  cfi?: string;
  keyPrefix?: string;
  maxBlockLength?: number;
  language?: string;
}

/**
 * Prefetch/walker path: build a canonical window from already-resolved spine
 * coordinates (the walker reports spineHref/spineIndex/chunkOffset/text), so no
 * CFI resolution or range extraction is needed.
 */
export async function buildEpubCanonicalWindowFromChunk(
  book: Book | null | undefined,
  options: BuildEpubCanonicalWindowFromChunkOptions,
): Promise<CanonicalWindowResult | null> {
  if (!book?.isOpen) return null;
  if (!options.text.trim()) return null;

  const plan = await buildSpineCanonicalPlan(book, {
    spineHref: options.spineHref,
    spineIndex: options.spineIndex,
    keyPrefix: options.keyPrefix,
    maxBlockLength: options.maxBlockLength,
    language: options.language,
  });
  if (plan.length === 0) return null;

  const startOffset = Math.max(0, options.chunkOffset);
  const endOffset = startOffset + normalizeSegmentIdentityText(options.text).length;
  const range = selectCanonicalWindow(plan, startOffset, endOffset);
  if (!range) return null;
  return buildResult(plan, range, {
    spineHref: options.spineHref,
    spineIndex: options.spineIndex,
    cfi: options.cfi,
  });
}
