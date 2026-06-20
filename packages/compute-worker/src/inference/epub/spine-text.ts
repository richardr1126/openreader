import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { DOMParser } from 'linkedom';

/**
 * One spine item's worker-extracted plain text. `index` is the 0-based spine
 * order (matches epub.js `section.index`); `href` is the manifest href resolved
 * relative to the OPF directory; `text` is the body text content — extracted
 * with the SAME DOM `body.textContent` semantics the client uses in
 * `getSpineItemPlainText`, so normalized segment text (and therefore audio
 * identity + per-segment charOffsets) match the client byte-for-byte.
 */
export interface EpubSpineItemText {
  index: number;
  href: string;
  text: string;
  /**
   * The chapter body split into block-level chunks (paragraphs, headings, list
   * items, …) in document order. Concatenated they reconstruct `text`. Emitting
   * per-block TTS source units (instead of one whole-chapter unit) keeps plan
   * derivation linear — mirroring how PDF derives one source unit per layout
   * block — and avoids the O(n²) whole-book canonical remapping that froze the
   * worker on large EPUBs.
   */
  blocks: string[];
}

// Block-level elements whose boundaries split a chapter into TTS source units.
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HGROUP',
  'LI', 'UL', 'OL', 'DL', 'DD', 'DT',
  'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'CAPTION', 'ADDRESS',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'DETAILS', 'SUMMARY',
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Minimal structural view of a DOM node — linkedom's node types don't line up with
// TS's lib.dom `Element`/`Node`, and we only need these few members.
interface DomNodeLike {
  nodeType: number;
  textContent: string | null;
  firstChild: DomNodeLike | null;
  nextSibling: DomNodeLike | null;
  tagName?: string;
}

/**
 * Split a chapter body into block-level text chunks in document order. Text nodes
 * are grouped by their nearest block-level ancestor, so the chunks tile the body's
 * `textContent` (concatenation reproduces it). Empty/whitespace-only chunks are
 * dropped. Falls back to a single chunk when the body has no block elements; the
 * per-chapter size is still bounded, so derivation stays well-behaved.
 */
function extractBlocks(body: DomNodeLike): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let currentKey: DomNodeLike | null | undefined = undefined;

  const flush = (): void => {
    if (current.length) {
      const text = current.join('');
      if (text.trim()) blocks.push(text);
    }
    current = [];
  };

  const walk = (node: DomNodeLike, nearestBlock: DomNodeLike | null): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === TEXT_NODE) {
        const text = child.textContent ?? '';
        if (!text) continue;
        if (currentKey !== nearestBlock) {
          flush();
          currentKey = nearestBlock;
        }
        current.push(text);
      } else if (child.nodeType === ELEMENT_NODE) {
        const tag = child.tagName ? child.tagName.toUpperCase() : '';
        walk(child, BLOCK_TAGS.has(tag) ? child : nearestBlock);
      }
    }
  };

  walk(body, null);
  flush();
  return blocks;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveHref(opfDir: string, href: string): string {
  const joined = opfDir ? path.posix.join(opfDir, href) : href;
  return path.posix.normalize(joined);
}

/**
 * Parse an EPUB (raw bytes) and return each spine item's plain body text in
 * spine order. Mirrors epub.js: spine order comes from `<spine><itemref>`,
 * hrefs from the manifest, and text from `body.textContent`.
 */
export async function extractEpubSpine(bytes: Buffer | Uint8Array | ArrayBuffer): Promise<EpubSpineItemText[]> {
  const zip = await JSZip.loadAsync(bytes instanceof ArrayBuffer ? Buffer.from(bytes) : bytes);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB container.xml not found');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

  const container = parser.parse(await containerFile.async('string')) as Record<string, unknown>;
  const rootfiles = asArray((container.container as Record<string, unknown> | undefined)?.rootfiles as never)
    .flatMap((node) => asArray((node as Record<string, unknown>).rootfile as never)) as Array<Record<string, unknown>>;
  const opfPath = rootfiles.map((rf) => rf['@_full-path']).find((p): p is string => typeof p === 'string' && !!p);
  if (!opfPath) throw new Error('EPUB OPF rootfile path missing');

  const opfFile = zip.file(opfPath) ?? zip.file(decodeURI(opfPath));
  if (!opfFile) throw new Error(`EPUB OPF not found at ${opfPath}`);
  const opfDir = path.posix.dirname(opfPath);
  const opfDirSegment = opfDir === '.' ? '' : opfDir;

  const pkg = (parser.parse(await opfFile.async('string')) as Record<string, unknown>).package as Record<string, unknown> | undefined;
  if (!pkg) throw new Error('EPUB OPF package element missing');

  const manifestItems = asArray((pkg.manifest as Record<string, unknown> | undefined)?.item as never) as Array<Record<string, unknown>>;
  const hrefById = new Map<string, string>();
  for (const item of manifestItems) {
    const id = item['@_id'];
    const href = item['@_href'];
    if (typeof id === 'string' && typeof href === 'string') hrefById.set(id, href);
  }

  const itemrefs = asArray((pkg.spine as Record<string, unknown> | undefined)?.itemref as never) as Array<Record<string, unknown>>;

  const out: EpubSpineItemText[] = [];
  for (let index = 0; index < itemrefs.length; index += 1) {
    const idref = itemrefs[index]['@_idref'];
    if (typeof idref !== 'string') continue;
    const href = hrefById.get(idref);
    if (!href) continue;
    const full = resolveHref(opfDirSegment, href);
    const file = zip.file(full) ?? zip.file(decodeURI(full));
    if (!file) continue;
    const html = await file.async('string');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bodyEl = (doc.body ?? doc.documentElement) as unknown as DomNodeLike | null;
    const text = bodyEl?.textContent ?? '';
    const blocks = bodyEl ? extractBlocks(bodyEl) : [];
    out.push({ index, href, text, blocks: blocks.length ? blocks : (text.trim() ? [text] : []) });
  }
  return out;
}
