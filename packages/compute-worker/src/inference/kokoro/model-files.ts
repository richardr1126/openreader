/**
 * The files local Kokoro needs, where they come from, and how they reach
 * `DOCSTORE_DIR/model/kokoro-82m`. Nothing here is committed or bundled: each
 * file is downloaded on first use and verified by size and sha256.
 *
 * Progress is reported per component — model weights, voice pack, English
 * pronunciation data — through the same `ModelDownloadProgressHandler` the
 * Whisper and PDF models use, so it reaches the reader over the existing
 * playback SSE.
 *
 * To work offline, place the files at their paths under the model directory
 * before first use (for example the iOS Misaki `Resources` folder copied to
 * `misaki/`); anything already present and matching its checksum is used as is.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DOCSTORE_DIR } from '../../infrastructure/platform';
import {
  downloadModelArtifact,
  type ModelComponentProgress,
  type ModelDownloadProgressHandler,
  type ModelFetch,
} from '../model-download';

/** onnx-community/Kokoro-82M-v1.0-ONNX (Apache-2.0), pinned. */
const KOKORO_ONNX_BASE_URL =
  'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231';
/** hexgrad/misaki (Apache-2.0) at the commit misaki 0.9.4's dictionaries were last changed. */
const MISAKI_DATA_BASE_URL =
  'https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data';
/**
 * Letter-to-sound rules induced from the Misaki dictionaries by the
 * OpenReader iOS tooling (Apache-2.0). They have no upstream home.
 * TODO(owner): publish letter_to_sound.tsv (for example as a release asset of
 * the openreader-ios repository or a Hugging Face dataset under the owner's
 * account) and set this URL. Until then the file must be placed by hand at
 * `<DOCSTORE_DIR>/model/kokoro-82m/misaki/letter_to_sound.tsv`.
 */
export const KOKORO_LETTER_TO_SOUND_URL = '';

export const KOKORO_MODEL_DIR = path.join(DOCSTORE_DIR, 'model', 'kokoro-82m');
/**
 * Full precision. On Apple M4 the int8 `model_quantized.onnx` (92 MB) ran at a
 * third of this speed (real-time factor 0.35 against 0.11) for 240 MB less
 * peak memory; the q8f16 variant was no better. Speed and reference quality
 * win over the larger one-time download.
 */
export const KOKORO_MODEL_FILE = 'onnx/model.onnx';
export const KOKORO_SAMPLE_RATE = 24_000;

const VOICE_BYTES = 510 * 256 * 4;
/** The English voices; Misaki phonemizes only English. */
export const KOKORO_VOICE_SHA256: Record<string, string> = {
  af_alloy: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45',
  af_aoede: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_jessica: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8',
  af_kore: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  af_nova: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f',
  af_river: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30',
  af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  af_sky: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9',
  am_adam: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
  am_echo: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3',
  am_eric: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832',
  am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  am_liam: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  am_onyx: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6',
  am_puck: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
  am_santa: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a',
  bf_alice: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bf_isabella: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f',
  bf_lily: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335',
  bm_daniel: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8',
  bm_fable: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  bm_lewis: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',
};

interface KokoroFile {
  path: string;
  url: string;
  size: number;
  sha256: string;
}

interface KokoroComponent {
  name: 'Model weights' | 'Voice pack' | 'English pronunciation data';
  files: KokoroFile[];
}

const misakiFile = (name: string, size: number, sha256: string): KokoroFile => ({
  path: `misaki/${name}`,
  url: `${MISAKI_DATA_BASE_URL}/${name}`,
  size,
  sha256,
});

export const KOKORO_COMPONENTS: readonly KokoroComponent[] = [
  {
    name: 'Model weights',
    files: [{
      path: KOKORO_MODEL_FILE,
      url: `${KOKORO_ONNX_BASE_URL}/${KOKORO_MODEL_FILE}`,
      size: 325_532_232,
      sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
    }],
  },
  {
    name: 'Voice pack',
    files: Object.entries(KOKORO_VOICE_SHA256).map(([voice, sha256]) => ({
      path: `voices/${voice}.bin`,
      url: `${KOKORO_ONNX_BASE_URL}/voices/${voice}.bin`,
      size: VOICE_BYTES,
      sha256,
    })),
  },
  {
    name: 'English pronunciation data',
    files: [
      misakiFile('us_gold.json', 3_000_469, 'dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f'),
      misakiFile('us_silver.json', 3_099_517, 'de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475'),
      misakiFile('gb_gold.json', 2_838_552, '29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71'),
      misakiFile('gb_silver.json', 3_663_898, '48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce'),
      {
        path: 'misaki/letter_to_sound.tsv',
        url: KOKORO_LETTER_TO_SOUND_URL,
        size: 2_306_291,
        sha256: '14e0911c6c92ea134c5ae830f89b69038ab9dbca5662896d012394f30309fbf2',
      },
    ],
  },
];

export function kokoroAssetPath(relativePath: string, modelDir = KOKORO_MODEL_DIR): string {
  return path.join(modelDir, relativePath);
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fileMatches(filePath: string, file: KokoroFile): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size !== file.size) return false;
  return (await sha256OfFile(filePath)) === file.sha256;
}

/**
 * Makes every Kokoro file present and verified. Files already in place are
 * checked rather than fetched again; a mismatch is replaced.
 */
export async function ensureKokoroAssetFiles(options: {
  modelDir?: string;
  components?: readonly KokoroComponent[];
  fetchImpl?: ModelFetch;
  onProgress?: ModelDownloadProgressHandler;
} = {}): Promise<void> {
  const modelDir = options.modelDir ?? KOKORO_MODEL_DIR;
  const components = options.components ?? KOKORO_COMPONENTS;
  const states: ModelComponentProgress[] = components.map((component) => ({
    name: component.name,
    totalBytes: component.files.reduce((sum, file) => sum + file.size, 0),
    downloadedBytes: 0,
    state: 'pending',
  }));

  // Find what is missing before saying anything: a warm start is silent.
  const missing = await Promise.all(components.map(async (component) => {
    const absent: KokoroFile[] = [];
    for (const file of component.files) {
      if (!(await fileMatches(kokoroAssetPath(file.path, modelDir), file))) absent.push(file);
    }
    return absent;
  }));
  if (missing.every((files) => files.length === 0)) return;

  const totalBytes = states.reduce((sum, state) => sum + state.totalBytes, 0);
  const report = async () => options.onProgress?.({
    downloadedBytes: states.reduce((sum, state) => sum + state.downloadedBytes, 0),
    totalBytes,
    components: states.map((state) => ({ ...state })),
  });

  components.forEach((component, index) => {
    const absentBytes = missing[index]!.reduce((sum, file) => sum + file.size, 0);
    states[index]!.downloadedBytes = states[index]!.totalBytes - absentBytes;
    if (absentBytes === 0) states[index]!.state = 'ready';
  });
  await report();

  for (const [index, component] of components.entries()) {
    const state = states[index]!;
    if (state.state === 'ready') continue;
    try {
      for (const file of missing[index]!) {
        if (!file.url) {
          throw new Error(
            `Local Kokoro needs ${file.path}, which has no download location yet. `
            + `Place it at ${kokoroAssetPath(file.path, modelDir)}.`,
          );
        }
        const target = kokoroAssetPath(file.path, modelDir);
        const tmp = `${target}.tmp`;
        await mkdir(path.dirname(target), { recursive: true });
        state.state = 'downloading';
        const before = state.downloadedBytes;
        await downloadModelArtifact({
          url: file.url,
          outPath: tmp,
          expectedBytes: file.size,
          fetchImpl: options.fetchImpl,
          onProgress: async ({ downloadedBytes }) => {
            state.downloadedBytes = before + Math.min(file.size, downloadedBytes);
            await report();
          },
        });
        state.state = 'verifying';
        await report();
        if (!(await fileMatches(tmp, file))) {
          await unlink(tmp).catch(() => undefined);
          throw new Error(`Local Kokoro file failed verification: ${file.path}`);
        }
        await rename(tmp, target);
        state.downloadedBytes = before + file.size;
      }
      state.state = 'ready';
      await report();
    } catch (error) {
      state.state = 'failed';
      await report();
      throw error;
    }
  }
}

let ready: Promise<void> | null = null;
const listeners = new Set<ModelDownloadProgressHandler>();

/** Shared by every caller: one download, progress fanned out to all waiting. */
export async function ensureKokoroAssets(onProgress?: ModelDownloadProgressHandler): Promise<void> {
  if (onProgress) listeners.add(onProgress);
  try {
    ready ??= ensureKokoroAssetFiles({
      onProgress: async (progress) => {
        await Promise.all([...listeners].map((listener) => listener(progress)));
      },
    }).catch((error: unknown) => {
      ready = null;
      throw error;
    });
    await ready;
  } finally {
    if (onProgress) listeners.delete(onProgress);
  }
}
