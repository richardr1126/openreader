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
    const text = doc.body?.textContent ?? doc.documentElement?.textContent ?? '';
    out.push({ index, href, text });
  }
  return out;
}
