import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { renderPage } from '../inference/pdf/render';

export type RenderedDocumentPreview = {
  bytes: Buffer;
  width: number;
  height: number;
};

const PREVIEW_JPEG_QUALITY = 82;

function normalizeTargetWidth(targetWidth: number): number {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return 400;
  return Math.max(64, Math.min(2048, Math.round(targetWidth)));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function findBestEpubCoverPath(opfPath: string, opfXml: string): string | null {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });
  const parsed = parser.parse(opfXml) as Record<string, unknown>;
  const pkg = (parsed.package ?? parsed['opf:package']) as Record<string, unknown> | undefined;
  if (!pkg) return null;

  const metadata = pkg.metadata as Record<string, unknown> | undefined;
  const manifest = pkg.manifest as Record<string, unknown> | undefined;
  const items = asArray((manifest?.item as Record<string, unknown> | Array<Record<string, unknown>> | undefined))
    .filter((item) => typeof item === 'object' && item !== null);

  const coverMetaId = asArray((metadata?.meta as Record<string, unknown> | Array<Record<string, unknown>> | undefined))
    .find((meta) => String(meta?.['@_name'] ?? '').trim().toLowerCase() === 'cover')?.['@_content'];

  const byCoverProperty = items.find((item) =>
    String(item['@_properties'] ?? '')
      .split(/\s+/)
      .map((value) => value.trim().toLowerCase())
      .includes('cover-image'),
  );
  const byMetaRef = coverMetaId
    ? items.find((item) => String(item['@_id'] ?? '') === String(coverMetaId))
    : null;
  const byNameHint = items.find((item) => String(item['@_id'] ?? '').toLowerCase().includes('cover'));
  const byImageType = items.find((item) => String(item['@_media-type'] ?? '').toLowerCase().startsWith('image/'));

  const selected = byCoverProperty ?? byMetaRef ?? byNameHint ?? byImageType;
  if (!selected) return null;

  const href = String(selected['@_href'] ?? '').trim();
  if (!href) return null;

  const opfDir = path.posix.dirname(opfPath);
  return path.posix.normalize(path.posix.join(opfDir, href));
}

async function renderImageBytesToJpeg(imageBytes: Buffer, targetWidth: number): Promise<RenderedDocumentPreview> {
  const bitmap = await loadImage(imageBytes);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Invalid source image dimensions');
  }

  const width = normalizeTargetWidth(targetWidth);
  const scale = width / sourceWidth;
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return {
    bytes: canvas.toBuffer('image/jpeg', PREVIEW_JPEG_QUALITY),
    width,
    height,
  };
}

export async function renderEpubCoverToJpeg(sourceBytes: Buffer, targetWidth: number): Promise<RenderedDocumentPreview> {
  const zip = await JSZip.loadAsync(sourceBytes);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB container.xml not found');

  const containerXml = await containerFile.async('string');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });
  const containerParsed = parser.parse(containerXml) as Record<string, unknown>;
  const rootfilesNode = (containerParsed.container as Record<string, unknown> | undefined)?.rootfiles as
    | Record<string, unknown>
    | undefined;
  const rootfiles = asArray(rootfilesNode?.rootfile as Record<string, unknown> | Array<Record<string, unknown>> | undefined);
  const rootfilePath = String(rootfiles[0]?.['@_full-path'] ?? '').trim();
  if (!rootfilePath) throw new Error('EPUB OPF rootfile path missing');

  const opfFile = zip.file(rootfilePath) ?? zip.file(decodeURI(rootfilePath));
  if (!opfFile) throw new Error(`EPUB OPF not found at ${rootfilePath}`);

  const coverPath = findBestEpubCoverPath(rootfilePath, await opfFile.async('string'));
  if (!coverPath) throw new Error('EPUB cover image not found');

  const coverFile = zip.file(coverPath) ?? zip.file(decodeURI(coverPath));
  if (!coverFile) throw new Error(`EPUB cover file missing at ${coverPath}`);

  return renderImageBytesToJpeg(await coverFile.async('nodebuffer'), targetWidth);
}

export async function renderPdfFirstPageToJpeg(sourceBytes: Buffer, targetWidth: number): Promise<RenderedDocumentPreview> {
  const width = normalizeTargetWidth(targetWidth);
  const isolatedBytes = Uint8Array.from(sourceBytes);
  const rendered = await renderPage({
    pdfBytes: isolatedBytes.buffer as ArrayBuffer,
    pageNumber: 1,
    targetWidth: width,
    format: 'jpeg',
    jpegQuality: PREVIEW_JPEG_QUALITY,
  });
  return {
    bytes: rendered.image,
    width: rendered.width,
    height: rendered.height,
  };
}
