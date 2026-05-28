import * as ort from 'onnxruntime-node';
import { readFile } from 'fs/promises';
import type { LayoutRegion, PdfTextItem } from './types';
import { ensureModel, MODEL_CONFIG_PATH, MODEL_PREPROCESSOR_PATH } from './model';
import { getOnnxThreadsPerJob } from '../config/cpu-budget';

interface RunLayoutInput {
  pageWidth: number;
  pageHeight: number;
  textItems: PdfTextItem[];
  pageImage: Buffer;
}

const DEFAULT_INPUT_SIZE = 800;
const MIN_SCORE = 0.5;
const CLASS_MIN_SCORE: Partial<Record<LayoutRegion['label'], number>> = {
  header: 0.4,
  footer: 0.4,
  figure_title: 0.45,
  footnote: 0.45,
  vision_footnote: 0.45,
};

const LABEL_MAP: Record<string, LayoutRegion['label'] | null> = {
  // PP-DocLayoutV3 labels
  abstract: 'abstract',
  algorithm: 'algorithm',
  aside_text: 'aside_text',
  chart: 'chart',
  content: 'content',
  display_formula: 'formula',
  doc_title: 'doc_title',
  figure_title: 'figure_title',
  footer: 'footer',
  footer_image: 'footer',
  footnote: 'footnote',
  formula_number: 'formula_number',
  header: 'header',
  header_image: 'header',
  image: 'image',
  inline_formula: 'formula',
  number: 'number',
  paragraph_title: 'paragraph_title',
  reference: 'reference',
  reference_content: 'reference_content',
  seal: 'seal',
  table: 'table',
  text: 'text',
  vertical_text: 'text',
  vision_footnote: 'vision_footnote',
};

const MIN_REGION_SIZE: Partial<Record<LayoutRegion['label'], { minWidth: number; minHeight: number }>> = {
  abstract: { minWidth: 24, minHeight: 14 },
  algorithm: { minWidth: 24, minHeight: 14 },
  aside_text: { minWidth: 24, minHeight: 14 },
  content: { minWidth: 24, minHeight: 14 },
  text: { minWidth: 24, minHeight: 14 },
  reference: { minWidth: 24, minHeight: 14 },
  reference_content: { minWidth: 24, minHeight: 14 },
  paragraph_title: { minWidth: 24, minHeight: 14 },
  doc_title: { minWidth: 24, minHeight: 14 },
  number: { minWidth: 18, minHeight: 12 },
  figure_title: { minWidth: 18, minHeight: 10 },
  footnote: { minWidth: 18, minHeight: 10 },
  vision_footnote: { minWidth: 18, minHeight: 10 },
  header: { minWidth: 18, minHeight: 10 },
  footer: { minWidth: 18, minHeight: 10 },
};

interface ModelPreprocessor {
  inputWidth: number;
  inputHeight: number;
  rescaleFactor: number;
  mean: [number, number, number];
  std: [number, number, number];
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let idToLabelPromise: Promise<Record<number, string>> | null = null;
let preprocessorPromise: Promise<ModelPreprocessor> | null = null;
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
      const onnxThreadsPerJob = getOnnxThreadsPerJob();
      const stableSessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: onnxThreadsPerJob,
        interOpNumThreads: 1,
        executionMode: 'sequential',
      };
      return ort.InferenceSession.create(modelPath, {
        ...stableSessionOptions,
      });
    })();
  }
  return sessionPromise;
}

async function getIdToLabel(): Promise<Record<number, string>> {
  if (!idToLabelPromise) {
    idToLabelPromise = (async () => {
      await ensureModel();
      const raw = await readFile(MODEL_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw) as { id2label?: Record<string, string> };
      const out: Record<number, string> = {};
      for (const [key, value] of Object.entries(parsed.id2label ?? {})) {
        const n = Number(key);
        if (Number.isFinite(n)) out[n] = String(value ?? '').trim();
      }
      return out;
    })();
  }
  return idToLabelPromise;
}

async function getPreprocessor(): Promise<ModelPreprocessor> {
  if (!preprocessorPromise) {
    preprocessorPromise = (async () => {
      await ensureModel();
      const raw = await readFile(MODEL_PREPROCESSOR_PATH, 'utf8');
      const parsed = JSON.parse(raw) as {
        size?: { width?: number; height?: number };
        rescale_factor?: number;
        image_mean?: number[];
        image_std?: number[];
      };

      const inputWidth = Math.max(1, Number(parsed.size?.width ?? DEFAULT_INPUT_SIZE));
      const inputHeight = Math.max(1, Number(parsed.size?.height ?? DEFAULT_INPUT_SIZE));
      const rescaleFactor = Number.isFinite(parsed.rescale_factor) ? Number(parsed.rescale_factor) : (1 / 255);
      const mean = [
        Number(parsed.image_mean?.[0] ?? 0),
        Number(parsed.image_mean?.[1] ?? 0),
        Number(parsed.image_mean?.[2] ?? 0),
      ] as [number, number, number];
      const std = [
        Number(parsed.image_std?.[0] ?? 1),
        Number(parsed.image_std?.[1] ?? 1),
        Number(parsed.image_std?.[2] ?? 1),
      ] as [number, number, number];

      return {
        inputWidth,
        inputHeight,
        rescaleFactor,
        mean,
        std,
      };
    })();
  }
  return preprocessorPromise;
}

function preprocessResized(
  image: CanvasImageSource,
  preprocessor: ModelPreprocessor,
  createCanvasFn: (width: number, height: number) => { getContext: (kind: '2d') => CanvasRenderingContext2D },
): ort.Tensor {
  const canvas = createCanvasFn(preprocessor.inputWidth, preprocessor.inputHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, preprocessor.inputWidth, preprocessor.inputHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, preprocessor.inputWidth, preprocessor.inputHeight);

  const imageData = ctx.getImageData(0, 0, preprocessor.inputWidth, preprocessor.inputHeight);
  const chw = new Float32Array(1 * 3 * preprocessor.inputWidth * preprocessor.inputHeight);
  const channelSize = preprocessor.inputWidth * preprocessor.inputHeight;
  for (let y = 0; y < preprocessor.inputHeight; y += 1) {
    for (let x = 0; x < preprocessor.inputWidth; x += 1) {
      const pixelIndex = (y * preprocessor.inputWidth + x) * 4;
      const idx = y * preprocessor.inputWidth + x;
      const r = imageData.data[pixelIndex] * preprocessor.rescaleFactor;
      const g = imageData.data[pixelIndex + 1] * preprocessor.rescaleFactor;
      const b = imageData.data[pixelIndex + 2] * preprocessor.rescaleFactor;

      chw[idx] = (r - preprocessor.mean[0]) / Math.max(1e-8, preprocessor.std[0]);
      chw[channelSize + idx] = (g - preprocessor.mean[1]) / Math.max(1e-8, preprocessor.std[1]);
      chw[channelSize * 2 + idx] = (b - preprocessor.mean[2]) / Math.max(1e-8, preprocessor.std[2]);
    }
  }
  return new ort.Tensor('float32', chw, [1, 3, preprocessor.inputHeight, preprocessor.inputWidth]);
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

function softmaxMax(logits: Float32Array, offset: number, count: number): { index: number; score: number } {
  let maxLogit = Number.NEGATIVE_INFINITY;
  let maxIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const value = logits[offset + i];
    if (value > maxLogit) {
      maxLogit = value;
      maxIndex = i;
    }
  }

  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    sum += Math.exp(logits[offset + i] - maxLogit);
  }

  const score = sum > 0 ? (1 / sum) : 0;
  return { index: maxIndex, score };
}

function normalizeModelLabel(rawLabel: string): string {
  const normalized = rawLabel.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.endsWith('_image')) {
    const base = normalized.slice(0, -'_image'.length);
    if (base === 'header' || base === 'footer') return normalized;
  }
  // Some exports suffix duplicate classes (e.g. header_1, footer_1, text_1).
  return normalized.replace(/_\d+$/g, '');
}

export async function runLayoutModel(input: RunLayoutInput): Promise<LayoutRegion[]> {
  const { pageWidth, pageHeight, textItems, pageImage } = input;
  if (!textItems.length) return [];
  if (!pageImage || pageImage.byteLength === 0) {
    throw new Error('layout-render-missing-page-image');
  }

  try {
    const [session, idToLabel, preprocessor, canvasFns] = await Promise.all([
      getSession(),
      getIdToLabel(),
      getPreprocessor(),
      getCanvasFns(),
    ]);

    const decodedPageImage = await canvasFns.loadImageFn(pageImage);
    const pixelValues = preprocessResized(decodedPageImage, preprocessor, canvasFns.createCanvasFn);
    const output = await session.run({ pixel_values: pixelValues });

    const logits = output.logits?.data as Float32Array | undefined;
    const predBoxes = output.pred_boxes?.data as Float32Array | undefined;
    if (!logits || !predBoxes) return [];

    const numQueries = Math.floor(predBoxes.length / 4);
    if (numQueries <= 0) return [];
    const classCount = Math.floor(logits.length / numQueries);
    if (classCount <= 0) return [];

    const regions: LayoutRegion[] = [];

    for (let queryIdx = 0; queryIdx < numQueries; queryIdx += 1) {
      const cls = softmaxMax(logits, queryIdx * classCount, classCount);
      const rawLabel = idToLabel[cls.index];
      if (!rawLabel) continue;
      const mapped = LABEL_MAP[normalizeModelLabel(rawLabel)];
      if (!mapped) continue;

      const minScore = CLASS_MIN_SCORE[mapped] ?? MIN_SCORE;
      if (!Number.isFinite(cls.score) || cls.score < minScore) continue;

      const cx = predBoxes[queryIdx * 4 + 0] * pageWidth;
      const cy = predBoxes[queryIdx * 4 + 1] * pageHeight;
      const w = predBoxes[queryIdx * 4 + 2] * pageWidth;
      const h = predBoxes[queryIdx * 4 + 3] * pageHeight;
      const rawBox: [number, number, number, number] = [
        cx - w / 2,
        cy - h / 2,
        cx + w / 2,
        cy + h / 2,
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
        confidence: cls.score,
      });
    }

    return regions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  } catch (error) {
    throw new Error(
      `layout-model-inference-failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
