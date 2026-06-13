import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  runOutput: {
    logits: { data: new Float32Array() },
    pred_boxes: { data: new Float32Array() },
  },
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn(async () => ({
      run: vi.fn(async () => mockState.runOutput),
    })),
  },
  Tensor: class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    if (path === '/tmp/model-config.json') {
      return JSON.stringify({
        id2label: {
          0: 'text',
          1: 'table',
        },
      });
    }

    if (path === '/tmp/model-preprocessor.json') {
      return JSON.stringify({
        size: { width: 2, height: 2 },
        rescale_factor: 1 / 255,
        image_mean: [0, 0, 0],
        image_std: [1, 1, 1],
      });
    }

    throw new Error(`unexpected readFile path: ${path}`);
  }),
}));

vi.mock('@napi-rs/canvas', () => {
  const createCanvas = (width: number, height: number) => ({
    getContext: () => ({
      fillStyle: '#ffffff',
      fillRect: () => {},
      drawImage: () => {},
      imageSmoothingEnabled: true,
      getImageData: () => ({
        data: new Uint8ClampedArray(width * height * 4).fill(255),
      }),
    }),
  });
  const loadImage = vi.fn(async () => ({ width: 2, height: 2 }));

  return {
    createCanvas,
    loadImage,
    default: {
      createCanvas,
      loadImage,
    },
  };
});

vi.mock('../../../src/inference/pdf/model', () => ({
  ensureModel: vi.fn(async () => '/tmp/model.onnx'),
  MODEL_CONFIG_PATH: '/tmp/model-config.json',
  MODEL_PREPROCESSOR_PATH: '/tmp/model-preprocessor.json',
}));

vi.mock('../../../src/infrastructure/config', () => ({
  getOnnxThreadsPerJob: vi.fn(() => 1),
}));

describe('runLayoutModel', () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.runOutput = {
      logits: { data: new Float32Array() },
      pred_boxes: { data: new Float32Array() },
    };
  });

  test('keeps one winner per query instead of dropping later queries behind duplicate class rows', async () => {
    mockState.runOutput = {
      logits: {
        data: new Float32Array([
          3,
          4,
          2.5,
          0.1,
        ]),
      },
      pred_boxes: {
        data: new Float32Array([
          0.25, 0.25, 0.3, 0.3,
          0.75, 0.75, 0.3, 0.3,
        ]),
      },
    };

    const { runLayoutModel } = await import('../../../src/inference/pdf/layout-model');
    const regions = await runLayoutModel({
      pageWidth: 100,
      pageHeight: 100,
      textItems: [{} as never],
      pageImage: Buffer.from([1]),
    });

    expect(regions).toHaveLength(2);
    expect(regions[0]?.label).toBe('text');
    expect(regions[0]?.confidence).toBeCloseTo(0.9168273, 6);
    expect(regions[0]?.bbox).toEqual([
      expect.closeTo(60, 5),
      expect.closeTo(60, 5),
      expect.closeTo(90, 5),
      expect.closeTo(90, 5),
    ]);
    expect(regions[1]?.label).toBe('table');
    expect(regions[1]?.confidence).toBeCloseTo(0.73105858, 6);
    expect(regions[1]?.bbox).toEqual([
      expect.closeTo(10, 5),
      expect.closeTo(10, 5),
      expect.closeTo(40, 5),
      expect.closeTo(40, 5),
    ]);
  });

  test('drops unlabeled query winners and keeps only labeled regions', async () => {
    mockState.runOutput = {
      logits: {
        data: new Float32Array([
          0.1,
          0.2,
          5,
          4,
          0.1,
          0.1,
        ]),
      },
      pred_boxes: {
        data: new Float32Array([
          0.25, 0.25, 0.3, 0.3,
          0.75, 0.75, 0.3, 0.3,
        ]),
      },
    };

    const { runLayoutModel } = await import('../../../src/inference/pdf/layout-model');
    const regions = await runLayoutModel({
      pageWidth: 100,
      pageHeight: 100,
      textItems: [{} as never],
      pageImage: Buffer.from([1]),
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]?.label).toBe('text');
    expect(regions[0]?.confidence).toBeCloseTo(0.96109135, 5);
    expect(regions[0]?.bbox).toEqual([
      expect.closeTo(60, 5),
      expect.closeTo(60, 5),
      expect.closeTo(90, 5),
      expect.closeTo(90, 5),
    ]);
  });
});
