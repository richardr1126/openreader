import * as ort from 'onnxruntime-node';
import { readFile } from 'fs/promises';
import path from 'path';
import type { LayoutRegion, PdfTextItem } from '@/lib/server/pdf-layout/types';
import { ensureModel } from '@/lib/server/pdf-layout/ensureModel';

interface RunLayoutInput {
  pageWidth: number;
  pageHeight: number;
  textItems: PdfTextItem[];
  pagePng: Buffer;
}

const INPUT_SIZE = 640;
const MIN_SCORE = 0.6;

const LABEL_MAP: Record<string, LayoutRegion['label'] | null> = {
  caption: 'caption',
  footnote: 'footnote',
  formula: 'formula',
  list_item: 'list-item',
  page_footer: 'page-footer',
  page_header: 'page-header',
  picture: 'picture',
  section_header: 'section-header',
  table: 'table',
  text: 'paragraph',
  title: 'title',
  document_index: null,
  code: null,
  checkbox_selected: null,
  checkbox_unselected: null,
  form: null,
  key_value_region: null,
};

const MIN_REGION_SIZE: Partial<Record<LayoutRegion['label'], { minWidth: number; minHeight: number }>> = {
  paragraph: { minWidth: 24, minHeight: 14 },
  'section-header': { minWidth: 24, minHeight: 14 },
  title: { minWidth: 24, minHeight: 14 },
  'list-item': { minWidth: 18, minHeight: 12 },
  caption: { minWidth: 18, minHeight: 10 },
  footnote: { minWidth: 18, minHeight: 10 },
  'page-header': { minWidth: 18, minHeight: 10 },
  'page-footer': { minWidth: 18, minHeight: 10 },
};

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let idToLabelPromise: Promise<Record<number, string>> | null = null;
let canvasFnsPromise: Promise<{
  createCanvasFn: (width: number, height: number) => { getContext: (kind: '2d') => CanvasRenderingContext2D };
  loadImageFn: (src: Buffer) => Promise<{ width: number; height: number } & CanvasImageSource>;
}> | null = null;

async function getCanvasFns(): Promise<{
  createCanvasFn: (width: number, height: number) => { getContext: (kind: '2d') => CanvasRenderingContext2D };
  loadImageFn: (src: Buffer) => Promise<{ width: number; height: number } & CanvasImageSource>;
}> {
  if (!canvasFnsPromise) {
    canvasFnsPromise = (async () => {
      const mod = await import('@napi-rs/canvas');
      const namespace = mod as Record<string, unknown>;
      const fallback = (namespace.default ?? {}) as Record<string, unknown>;
      const createCanvasFn = (namespace.createCanvas ?? fallback.createCanvas) as
        | ((width: number, height: number) => { getContext: (kind: '2d') => CanvasRenderingContext2D })
        | undefined;
      const loadImageFn = (namespace.loadImage ?? fallback.loadImage) as
        | ((src: Buffer) => Promise<{ width: number; height: number } & CanvasImageSource>)
        | undefined;

      if (typeof createCanvasFn !== 'function' || typeof loadImageFn !== 'function') {
        throw new Error(
          `Canvas runtime missing createCanvas/loadImage exports (keys=${Object.keys(namespace).join(',')}; defaultKeys=${Object.keys(fallback).join(',')})`,
        );
      }

      return { createCanvasFn, loadImageFn };
    })();
  }
  return canvasFnsPromise;
}

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const modelPath = await ensureModel();
      return ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
    })();
  }
  return sessionPromise;
}

async function getIdToLabel(): Promise<Record<number, string>> {
  if (!idToLabelPromise) {
    idToLabelPromise = (async () => {
      const modelPath = await ensureModel();
      const configPath = path.join(path.dirname(modelPath), 'docling-layout-heron.config.json');
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { id2label?: Record<string, string> };
      const out: Record<number, string> = {};
      for (const [key, value] of Object.entries(parsed.id2label ?? {})) {
        const n = Number(key);
        if (Number.isFinite(n)) out[n] = value;
      }
      return out;
    })();
  }
  return idToLabelPromise;
}

function preprocessLetterboxed(
  image: CanvasImageSource,
  createCanvasFn: (width: number, height: number) => { getContext: (kind: '2d') => CanvasRenderingContext2D },
): {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
} {
  const sourceWidth = Math.max(1, Number((image as { width?: number }).width ?? INPUT_SIZE));
  const sourceHeight = Math.max(1, Number((image as { height?: number }).height ?? INPUT_SIZE));
  const scale = Math.min(INPUT_SIZE / sourceWidth, INPUT_SIZE / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padX = Math.floor((INPUT_SIZE - drawWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - drawHeight) / 2);

  const canvas = createCanvasFn(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, padX, padY, drawWidth, drawHeight);

  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const data = new Uint8Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < INPUT_SIZE; y += 1) {
    for (let x = 0; x < INPUT_SIZE; x += 1) {
      const pixelIndex = (y * INPUT_SIZE + x) * 4;
      const chwIndex = y * INPUT_SIZE + x;
      data[0 * INPUT_SIZE * INPUT_SIZE + chwIndex] = imageData.data[pixelIndex];
      data[1 * INPUT_SIZE * INPUT_SIZE + chwIndex] = imageData.data[pixelIndex + 1];
      data[2 * INPUT_SIZE * INPUT_SIZE + chwIndex] = imageData.data[pixelIndex + 2];
    }
  }

  return {
    tensor: new ort.Tensor('uint8', data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    scale,
    padX,
    padY,
  };
}

function clampBox(
  bbox: [number, number, number, number],
  pageWidth: number,
  pageHeight: number,
): [number, number, number, number] | null {
  const x0 = Math.max(0, Math.min(pageWidth, bbox[0]));
  const y0 = Math.max(0, Math.min(pageHeight, bbox[1]));
  const x1 = Math.max(0, Math.min(pageWidth, bbox[2]));
  const y1 = Math.max(0, Math.min(pageHeight, bbox[3]));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

export async function runLayoutModel(input: RunLayoutInput): Promise<LayoutRegion[]> {
  const { pageWidth, pageHeight, textItems, pagePng } = input;
  if (!textItems.length) return [];
  if (!pagePng || pagePng.byteLength === 0) {
    throw new Error('layout-render-missing-page-image');
  }

  try {
    const [session, idToLabel, canvasFns] = await Promise.all([getSession(), getIdToLabel(), getCanvasFns()]);
    const pageImage = await canvasFns.loadImageFn(pagePng);
    const preprocess = preprocessLetterboxed(pageImage, canvasFns.createCanvasFn);
    const targetSizes = new ort.Tensor('int64', new BigInt64Array([BigInt(INPUT_SIZE), BigInt(INPUT_SIZE)]), [1, 2]);
    const output = await session.run({
      images: preprocess.tensor,
      orig_target_sizes: targetSizes,
    });

    const labels = output.labels?.data as BigInt64Array | Int32Array | undefined;
    const boxes = output.boxes?.data as Float32Array | undefined;
    const scores = output.scores?.data as Float32Array | undefined;
    if (!labels || !boxes || !scores) return [];

    const regions: LayoutRegion[] = [];
    const count = Math.min(scores.length, Math.floor(boxes.length / 4), labels.length);
    for (let i = 0; i < count; i += 1) {
      const score = scores[i];
      if (!Number.isFinite(score) || score < MIN_SCORE) continue;

      const rawLabel = Number(labels[i]);
      const labelName = idToLabel[rawLabel];
      if (!labelName) continue;
      const mapped = LABEL_MAP[labelName];
      if (!mapped) continue;

      const modelBox: [number, number, number, number] = [
        boxes[i * 4 + 0],
        boxes[i * 4 + 1],
        boxes[i * 4 + 2],
        boxes[i * 4 + 3],
      ];
      const rawBox: [number, number, number, number] = [
        (modelBox[0] - preprocess.padX) / preprocess.scale,
        (modelBox[1] - preprocess.padY) / preprocess.scale,
        (modelBox[2] - preprocess.padX) / preprocess.scale,
        (modelBox[3] - preprocess.padY) / preprocess.scale,
      ];
      const clamped = clampBox(rawBox, pageWidth, pageHeight);
      if (!clamped) continue;

      const sizeRule = MIN_REGION_SIZE[mapped];
      if (sizeRule) {
        const width = clamped[2] - clamped[0];
        const height = clamped[3] - clamped[1];
        if (width < sizeRule.minWidth || height < sizeRule.minHeight) continue;
      }

      regions.push({
        bbox: clamped,
        label: mapped,
        confidence: score,
      });
    }

    return regions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  } catch (error) {
    throw new Error(
      `layout-model-inference-failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
