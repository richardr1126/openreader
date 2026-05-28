import path from 'path';
import type { Canvas } from '@napi-rs/canvas';

type CanvasRuntime = {
  DOMMatrixCtor: unknown;
  Path2DCtor: unknown;
  createCanvasFn: (width: number, height: number) => Canvas;
};

let canvasRuntimePromise: Promise<CanvasRuntime> | null = null;

function resolvePdfjsStandardFontDataUrl(): string {
  const standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
  return `${standardFontDir.replace(/\/?$/, '/')}`;
}

async function loadCanvasRuntime(): Promise<CanvasRuntime> {
  if (!canvasRuntimePromise) {
    canvasRuntimePromise = (async () => {
      const mod = await import('@napi-rs/canvas');
      const namespace = mod as Record<string, unknown>;
      const fallback = (namespace.default ?? {}) as Record<string, unknown>;

      const createCanvasFn = (namespace.createCanvas ?? fallback.createCanvas) as
        | ((width: number, height: number) => Canvas)
        | undefined;
      const DOMMatrixCtor = namespace.DOMMatrix ?? fallback.DOMMatrix;
      const Path2DCtor = namespace.Path2D ?? fallback.Path2D;

      if (typeof createCanvasFn !== 'function') {
        throw new Error(
          `Canvas runtime missing createCanvas export (keys=${Object.keys(namespace).join(',')}; defaultKeys=${Object.keys(fallback).join(',')})`,
        );
      }
      if (!DOMMatrixCtor || !Path2DCtor) {
        throw new Error(
          `Canvas runtime missing DOMMatrix/Path2D exports (keys=${Object.keys(namespace).join(',')}; defaultKeys=${Object.keys(fallback).join(',')})`,
        );
      }

      return {
        DOMMatrixCtor,
        Path2DCtor,
        createCanvasFn,
      };
    })();
  }
  return canvasRuntimePromise;
}

function ensureNodeCanvasGlobals(runtime: CanvasRuntime): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === 'undefined') g.DOMMatrix = runtime.DOMMatrixCtor;
  if (typeof g.Path2D === 'undefined') g.Path2D = runtime.Path2DCtor;
}

interface RenderInput {
  pdfBytes: ArrayBuffer;
  pageNumber: number;
  scale?: number;
  targetWidth?: number;
  format?: 'png' | 'jpeg';
  jpegQuality?: number;
}

function createPdfjsCanvasFactory(runtime: CanvasRuntime) {
  return class OpenReaderCanvasFactory {
    create(width: number, height: number) {
      const canvas = runtime.createCanvasFn(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
      return {
        canvas,
        context: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      };
    }

    reset(target: { canvas: Canvas; context: CanvasRenderingContext2D }, width: number, height: number): void {
      target.canvas.width = Math.max(1, Math.floor(width));
      target.canvas.height = Math.max(1, Math.floor(height));
    }

    destroy(target: { canvas: Canvas; context: CanvasRenderingContext2D }): void {
      target.canvas.width = 0;
      target.canvas.height = 0;
      // @ts-expect-error pdf.js expects these nulled on destroy
      target.canvas = null;
      // @ts-expect-error pdf.js expects these nulled on destroy
      target.context = null;
    }
  };
}

export async function renderPage({
  pdfBytes,
  pageNumber,
  scale = 1.5,
  targetWidth,
  format = 'png',
  jpegQuality = 82,
}: RenderInput): Promise<{
  width: number;
  height: number;
  image: Buffer;
  contentType: 'image/png' | 'image/jpeg';
}> {
  // pdf.js may detach the provided ArrayBuffer. Work with an isolated copy so
  // callers can safely reuse their original bytes across pages/calls.
  const isolatedBytes = new Uint8Array(pdfBytes).slice();

  const canvasRuntime = await loadCanvasRuntime();
  ensureNodeCanvasGlobals(canvasRuntime);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }

  const standardFontDataUrl = resolvePdfjsStandardFontDataUrl();

  const loadingTask = pdfjs.getDocument({
    data: isolatedBytes,
    useWorkerFetch: false,
    standardFontDataUrl,
    isEvalSupported: false,
    // Ensure pdf.js transport uses our canvas backend in Node/Next runtime.
    CanvasFactory: createPdfjsCanvasFactory(canvasRuntime),
  });

  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const effectiveScale = typeof targetWidth === 'number' && Number.isFinite(targetWidth) && targetWidth > 0
      ? (Math.max(1, Math.round(targetWidth)) / Math.max(1, baseViewport.width))
      : scale;
    const viewport = page.getViewport({ scale: effectiveScale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = canvasRuntime.createCanvasFn(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const renderTask = page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      intent: 'display',
    });
    await renderTask.promise;
    const contentType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const image = format === 'jpeg'
      ? canvas.toBuffer('image/jpeg', jpegQuality)
      : canvas.toBuffer('image/png');
    return {
      width,
      height,
      image,
      contentType,
    };
  } finally {
    await pdf.destroy().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }
}
