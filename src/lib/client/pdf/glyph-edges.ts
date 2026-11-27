import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode, OPS } from 'pdfjs-dist';

/**
 * Horizontal character edges taken from a page's real glyph advances.
 *
 * The pdf.js text layer lays each run out in a generic stand-in font and
 * stretches it to the run's width, so only the two ends of a run are exact.
 * Word highlights take their left and right edges from here instead, and keep
 * the text layer for everything else. A run whose glyphs cannot be paired with
 * its text gets `null`, and the caller keeps the text-layer box.
 */

type Matrix = [number, number, number, number, number, number];

type FontInfo = { fontMatrix?: number[]; vertical?: boolean };

export type GlyphChar = { ch: string; x0: number; x1: number; y: number };

export type TextRun = { str: string; transform: number[]; width: number; dir?: string };

type GlyphArg = { unicode?: string; width?: number; isSpace?: boolean } | number | null;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: readonly number[]): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const AXIS_EPSILON = 1e-6;

/**
 * Walk a page's operator list the way pdf.js's canvas renderer advances text,
 * and record each character's horizontal extent in page space. Only upright,
 * left-to-right text is recorded.
 */
export function collectGlyphChars(
  operatorList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  fontInfo: (loadedName: string) => FontInfo | undefined,
): GlyphChar[] {
  const chars: GlyphChar[] = [];
  let state = {
    ctm: IDENTITY,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    leading: 0,
    fontSize: 0,
    fontDirection: 1,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0] as number[],
    vertical: false,
    charSpacing: 0,
    wordSpacing: 0,
    textHScale: 1,
    textRise: 0,
  };
  const saved: typeof state[] = [];
  const moveText = (tx: number, ty: number) => {
    state.lineX += tx;
    state.lineY += ty;
    state.x = state.lineX;
    state.y = state.lineY;
  };

  const setFont = (loadedName: string, size: number) => {
    const info = fontInfo(loadedName);
    state.fontMatrix = info?.fontMatrix?.[0] ? info.fontMatrix : [0.001, 0, 0, 0.001, 0, 0];
    state.vertical = Boolean(info?.vertical);
    state.fontDirection = size < 0 ? -1 : 1;
    state.fontSize = Math.abs(size);
  };

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const args = operatorList.argsArray[i] as unknown[] | null;
    switch (operatorList.fnArray[i]) {
      case OPS.save:
      case OPS.paintFormXObjectBegin:
        saved.push({ ...state });
        if (operatorList.fnArray[i] === OPS.paintFormXObjectBegin && Array.isArray(args?.[0])) {
          state.ctm = multiply(state.ctm, args[0] as number[]);
        }
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
        state = saved.pop() ?? state;
        break;
      case OPS.transform:
        state.ctm = multiply(state.ctm, args as number[]);
        break;
      case OPS.beginText:
        state.textMatrix = IDENTITY;
        state.x = state.lineX = state.y = state.lineY = 0;
        break;
      case OPS.setTextMatrix:
        state.textMatrix = (args as number[]).slice(0, 6) as Matrix;
        state.x = state.lineX = state.y = state.lineY = 0;
        break;
      case OPS.moveText:
        moveText(args![0] as number, args![1] as number);
        break;
      case OPS.setLeadingMoveText:
        state.leading = args![1] as number;
        moveText(args![0] as number, args![1] as number);
        break;
      case OPS.nextLine:
        moveText(0, state.leading);
        break;
      case OPS.setLeading:
        state.leading = -(args![0] as number);
        break;
      case OPS.setCharSpacing:
        state.charSpacing = args![0] as number;
        break;
      case OPS.setWordSpacing:
        state.wordSpacing = args![0] as number;
        break;
      case OPS.setHScale:
        state.textHScale = (args![0] as number) / 100;
        break;
      case OPS.setTextRise:
        state.textRise = args![0] as number;
        break;
      case OPS.setFont:
        setFont(args![0] as string, args![1] as number);
        break;
      case OPS.setGState:
        // An ExtGState can select a font too, as pdf.js's canvas does.
        for (const [key, value] of (args![0] as Array<[string, unknown]>)) {
          if (key === 'Font') setFont(...(value as [string, number]));
        }
        break;
      case OPS.showText:
        state.x += showText(args![0] as GlyphArg[], state, chars);
        break;
      default:
        break;
    }
  }
  return chars;
}

function showText(
  glyphs: readonly GlyphArg[],
  state: {
    ctm: Matrix;
    textMatrix: Matrix;
    x: number;
    y: number;
    fontSize: number;
    fontDirection: number;
    fontMatrix: number[];
    vertical: boolean;
    charSpacing: number;
    wordSpacing: number;
    textHScale: number;
    textRise: number;
  },
  chars: GlyphChar[],
): number {
  const { fontSize, fontDirection, vertical } = state;
  if (fontSize === 0 || vertical) return 0;
  const hScale = state.textHScale * fontDirection;
  const advanceScale = fontSize * state.fontMatrix[0];
  const m = multiply(state.ctm, state.textMatrix);
  const upright = Math.abs(m[1]) < AXIS_EPSILON && Math.abs(m[2]) < AXIS_EPSILON && m[0] * hScale > 0;
  const toPage = (local: number) => m[0] * (state.x + local * hScale) + m[2] * (state.y + state.textRise) + m[4];
  const baseline = m[1] * state.x + m[3] * (state.y + state.textRise) + m[5];

  let x = 0;
  for (const glyph of glyphs) {
    if (typeof glyph === 'number') {
      x -= (glyph * fontSize) / 1000;
      continue;
    }
    if (!glyph) continue;
    const glyphWidth = (glyph.width ?? 0) * advanceScale;
    const spacing = (glyph.isSpace ? state.wordSpacing : 0) + state.charSpacing;
    if (upright) {
      // A ligature glyph covers several characters; share its advance evenly.
      const text = [...(glyph.unicode ?? '').normalize('NFKC')];
      text.forEach((ch, k) => {
        chars.push({
          ch,
          x0: toPage(x + (glyphWidth * k) / text.length),
          x1: toPage(x + (glyphWidth * (k + 1)) / text.length),
          y: baseline,
        });
      });
    }
    x += glyphWidth + spacing * fontDirection;
  }
  return x * hScale;
}

const isWhitespace = (ch: string) => /\s/u.test(ch);

/**
 * Pair a text-content run with the glyphs on its baseline, and return each
 * UTF-16 unit's [start, end] as a fraction of the run's width. pdf.js may add
 * spaces with no glyph; those span the gap between their neighbours.
 */
export function runCharEdges(run: TextRun, chars: readonly GlyphChar[]): Float64Array | null {
  const [a, b, c, d, originX, originY] = run.transform;
  if (!run.str || run.width <= 0 || run.dir === 'rtl') return null;
  if (Math.abs(b) > AXIS_EPSILON || Math.abs(c) > AXIS_EPSILON || a <= 0) return null;
  const tolerance = Math.max(0.6, Math.abs(d) * 0.1);
  const glyphs = chars.filter((ch) => (
    Math.abs(ch.y - originY) < tolerance
    && ch.x0 >= originX - 0.5
    && ch.x0 < originX + run.width - 0.01
  ));
  if (!glyphs.length) return null;

  const edges = new Float64Array(run.str.length * 2);
  const pending: number[] = [];
  let unit = 0;
  let g = 0;
  let previousEnd = originX;
  const set = (index: number, x0: number, x1: number) => {
    edges[index * 2] = (x0 - originX) / run.width;
    edges[index * 2 + 1] = (x1 - originX) / run.width;
  };
  for (const cp of run.str) {
    while (g < glyphs.length && glyphs[g].ch !== cp && isWhitespace(glyphs[g].ch)) g += 1;
    const glyph = glyphs[g];
    if (glyph && glyph.ch === cp) {
      for (const index of pending) set(index, previousEnd, glyph.x0);
      pending.length = 0;
      for (let k = 0; k < cp.length; k += 1) set(unit + k, glyph.x0, glyph.x1);
      previousEnd = glyph.x1;
      g += 1;
    } else if (isWhitespace(cp)) {
      for (let k = 0; k < cp.length; k += 1) pending.push(unit + k);
    } else {
      return null;
    }
    unit += cp.length;
  }
  for (const index of pending) set(index, previousEnd, previousEnd);
  if (glyphs.slice(g).some((glyph) => !isWhitespace(glyph.ch))) return null;
  return edges;
}

/** One entry per text-layer span: the run's text and its character edges. */
type PageEdges = Array<{ str: string; edges: Float64Array | null }>;

const pageEdgeCache = new WeakMap<PDFDocumentProxy, Map<number, PageEdges | 'loading' | 'failed'>>();

async function loadPageEdges(page: PDFPageProxy): Promise<PageEdges> {
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList({ annotationMode: AnnotationMode.DISABLE }),
  ]);
  const chars = collectGlyphChars(operatorList, (name) => (
    page.commonObjs.has(name) ? page.commonObjs.get(name) as FontInfo : undefined
  ));
  // The text layer draws one span per run with text, in content order.
  return textContent.items
    .flatMap((item) => ('str' in item && item.str !== '' ? [item] : []))
    .map((run) => ({ str: run.str, edges: runCharEdges(run, chars) }));
}

/**
 * Character edges for each text-layer span of a page, or null until they are
 * ready. The first call starts loading them in the background.
 */
export function pdfPageCharEdges(pdfDocument: PDFDocumentProxy, pageNumber: number): PageEdges | null {
  let pages = pageEdgeCache.get(pdfDocument);
  if (!pages) {
    pages = new Map();
    pageEdgeCache.set(pdfDocument, pages);
  }
  const entry = pages.get(pageNumber);
  if (Array.isArray(entry)) return entry;
  if (entry) return null;

  pages.set(pageNumber, 'loading');
  const target = pages;
  pdfDocument.getPage(pageNumber)
    .then(loadPageEdges)
    .then((edges) => { target.set(pageNumber, edges); })
    .catch(() => { target.set(pageNumber, 'failed'); });
  return null;
}

const spanCharEdges = new WeakMap<HTMLElement, Float64Array | null>();

/** Character edges for a react-pdf text-layer span, once its page's are loaded. */
function charEdgesForSpan(span: HTMLElement, pdfDocument: PDFDocumentProxy): Float64Array | null {
  if (spanCharEdges.has(span)) return spanCharEdges.get(span) ?? null;
  const pageNumber = Number(span.closest<HTMLElement>('.react-pdf__Page')?.dataset.pageNumber);
  const textLayer = span.closest('.react-pdf__Page__textContent');
  if (!pageNumber || !textLayer) return null;
  // The edges are fractions along the content's x axis, which only runs left to
  // right on screen when the page is not rotated.
  if (Number(textLayer.getAttribute('data-main-rotation') ?? 0) % 360 !== 0) return null;
  const pageEdges = pdfPageCharEdges(pdfDocument, pageNumber);
  if (!pageEdges) return null;
  textLayer.querySelectorAll<HTMLElement>('span[role="presentation"]').forEach((node, index) => {
    const run = pageEdges[index];
    spanCharEdges.set(node, run && run.str === node.textContent ? run.edges : null);
  });
  return spanCharEdges.get(span) ?? null;
}

/**
 * The text layer's boxes for `range` inside one span, with the left and right
 * edges moved onto the glyphs when they are known.
 */
export function pdfWordRects(span: HTMLElement, range: Range, pdfDocument: PDFDocumentProxy | undefined): DOMRect[] {
  const rects = Array.from(range.getClientRects());
  const edges = pdfDocument && rects.length ? charEdgesForSpan(span, pdfDocument) : null;
  if (!edges || range.endOffset <= range.startOffset) return rects;
  const spanRect = span.getBoundingClientRect();
  const left = spanRect.left + edges[range.startOffset * 2] * spanRect.width;
  const right = spanRect.left + edges[(range.endOffset - 1) * 2 + 1] * spanRect.width;
  if (!(right > left)) return rects;
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return [new DOMRect(left, top, right - left, bottom - top)];
}
