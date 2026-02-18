import path from 'path';
import { DOMMatrix, Path2D, createCanvas, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export type RenderedDocumentPreview = {
  bytes: Buffer;
  width: number;
  height: number;
};

type CanvasAndContext = {
  canvas: unknown;
  context: unknown;
};

type NodeCanvasFactory = {
  create: (width: number, height: number) => CanvasAndContext;
  reset: (target: CanvasAndContext, width: number, height: number) => void;
  destroy: (target: CanvasAndContext) => void;
};

function ensureNodeCanvasGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === 'undefined') {
    g.DOMMatrix = DOMMatrix as unknown;
  }
  if (typeof g.Path2D === 'undefined') {
    g.Path2D = Path2D as unknown;
  }
}

function normalizeTargetWidth(targetWidth: number): number {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return 240;
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
    .find((meta) => {
      const name = String(meta?.['@_name'] ?? '').trim().toLowerCase();
      return name === 'cover';
    })?.['@_content'];

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
  const width = bitmap.width;
  const height = bitmap.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid source image dimensions');
  }

  const target = normalizeTargetWidth(targetWidth);
  const scale = target / width;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
  return {
    bytes: canvas.toBuffer('image/jpeg', 82),
    width: outWidth,
    height: outHeight,
  };
}

export async function renderEpubCoverToJpeg(sourceBytes: Buffer, targetWidth: number): Promise<RenderedDocumentPreview> {
  const zip = await JSZip.loadAsync(sourceBytes);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('EPUB container.xml not found');
  }

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
  if (!rootfilePath) {
    throw new Error('EPUB OPF rootfile path missing');
  }

  const opfFile = zip.file(rootfilePath) ?? zip.file(decodeURI(rootfilePath));
  if (!opfFile) {
    throw new Error(`EPUB OPF not found at ${rootfilePath}`);
  }
  const opfXml = await opfFile.async('string');
  const coverPath = findBestEpubCoverPath(rootfilePath, opfXml);
  if (!coverPath) {
    throw new Error('EPUB cover image not found');
  }

  const coverFile = zip.file(coverPath) ?? zip.file(decodeURI(coverPath));
  if (!coverFile) {
    throw new Error(`EPUB cover file missing at ${coverPath}`);
  }

  const coverBytes = await coverFile.async('nodebuffer');
  return renderImageBytesToJpeg(coverBytes, targetWidth);
}

export async function renderPdfFirstPageToJpeg(sourceBytes: Buffer, targetWidth: number): Promise<RenderedDocumentPreview> {
  ensureNodeCanvasGlobals();

  type PdfViewport = {
    width: number;
    height: number;
  };
  type PdfPage = {
    getViewport: (params: { scale: number }) => PdfViewport;
    render: (params: {
      canvasContext: unknown;
      viewport: PdfViewport;
      intent: 'display';
      canvasFactory?: NodeCanvasFactory;
    }) => { promise: Promise<void> };
  };

  // pdfjs-dist legacy build works in Node and avoids relying on DOM workers.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - pdfjs-dist legacy build path has no dedicated TypeScript declaration.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (options: Record<string, unknown>) => {
      promise: Promise<{ getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> }>;
      destroy: () => Promise<void>;
    };
    GlobalWorkerOptions?: { workerSrc?: string; workerPort?: unknown };
  };

  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }

  const standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
  const standardFontDataUrl = `${standardFontDir.replace(/\/?$/, '/')}`;

  const nodeCanvasFactory: NodeCanvasFactory = {
    create: (width, height) => {
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      return { canvas, context };
    },
    reset: (target, width, height) => {
      const canvas = target.canvas as { width: number; height: number };
      canvas.width = width;
      canvas.height = height;
    },
    destroy: (target) => {
      const canvas = target.canvas as { width: number; height: number };
      canvas.width = 0;
      canvas.height = 0;
    },
  };

  class PdfNodeCanvasFactory {
    create(width: number, height: number): CanvasAndContext {
      return nodeCanvasFactory.create(width, height);
    }
    reset(target: CanvasAndContext, width: number, height: number): void {
      nodeCanvasFactory.reset(target, width, height);
    }
    destroy(target: CanvasAndContext): void {
      nodeCanvasFactory.destroy(target);
    }
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(sourceBytes),
    useWorkerFetch: false,
    standardFontDataUrl,
    CanvasFactory: PdfNodeCanvasFactory,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const target = normalizeTargetWidth(targetWidth);
    const scale = target / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    const outWidth = Math.max(1, Math.floor(scaledViewport.width));
    const outHeight = Math.max(1, Math.floor(scaledViewport.height));
    const canvas = createCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outWidth, outHeight);

    const renderTask = page.render({
      canvasContext: ctx,
      viewport: scaledViewport,
      intent: 'display',
      canvasFactory: nodeCanvasFactory,
    });
    await renderTask.promise;

    return {
      bytes: canvas.toBuffer('image/jpeg', 82),
      width: outWidth,
      height: outHeight,
    };
  } finally {
    await pdf.destroy().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }
}
