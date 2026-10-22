/**
 * The files local Kokoro needs, where they come from, and how they reach
 * `DOCSTORE_DIR/model/kokoro-82m`. Nothing here is committed or bundled: each
 * file is downloaded on first use and verified by size and sha256.
 *
 * Progress is reported per component — model weights, voice pack,
 * pronunciation data — through the same `ModelDownloadProgressHandler` the
 * Whisper and PDF models use, so it reaches the reader over the existing
 * playback SSE.
 *
 * The letter-to-sound rules have no upstream home, so they ship with the
 * worker in `assets/` instead (see `kokoroLetterToSoundPath`).
 *
 * To work offline, place the files at their paths under the model directory
 * before first use (for example the iOS Misaki `Resources` dictionaries copied
 * to `misaki/`); anything already present and matching its checksum is used
 * as is.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DOCSTORE_DIR } from '../../infrastructure/platform';
import { resolveWorkerPath } from '../../worker-paths';
import {
  downloadModelArtifact,
  type ModelComponentProgress,
  type ModelDownloadProgressHandler,
  type ModelFetch,
} from '../model-download';
import type { LearnedLanguage } from './misaki/romance-numbers';

/**
 * richardr1126/Kokoro-82M-OpenReader (Apache-2.0), pinned: Kokoro-82M exported
 * with its per-token durations as a second output, which give word timings
 * (`packaging/kokoro-onnx`), and the Spanish, Hindi, Italian and Portuguese G2P
 * tables. The voices are onnx-community's, byte for byte.
 */
const KOKORO_REPO_URL =
  'https://huggingface.co/richardr1126/Kokoro-82M-OpenReader/resolve/ee9a26d2886e5a60953de169a2c944fa327e71f8';
const KOKORO_ONNX_BASE_URL = `${KOKORO_REPO_URL}/onnx`;
/** hexgrad/misaki (Apache-2.0) at the commit misaki 0.9.4's dictionaries were last changed. */
const MISAKI_DATA_BASE_URL =
  'https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data';
/**
 * Letter-to-sound rules induced from each dialect's Misaki dictionaries by the
 * OpenReader iOS tooling. They have no upstream to download from, so the
 * worker bundles them (2.3 MB American, 2.4 MB British).
 */
export function kokoroLetterToSoundPath(british: boolean): string {
  return resolveWorkerPath('inference', 'kokoro', 'assets', british ? 'letter_to_sound_gb.tsv' : 'letter_to_sound.tsv');
}

export const KOKORO_MODEL_DIR = path.join(DOCSTORE_DIR, 'model', 'kokoro-82m');
/**
 * Full precision. On Apple M4 the int8 `model_quantized.onnx` (92 MB) ran at a
 * third of this speed (real-time factor 0.35 against 0.11) for 240 MB less
 * peak memory; the q8f16 variant was no better. Speed and reference quality
 * win over the larger one-time download.
 */
export const KOKORO_MODEL_FILE = 'onnx/model.onnx';
const KOKORO_MODEL_URL = `${KOKORO_ONNX_BASE_URL}/model.onnx`;
export const KOKORO_SAMPLE_RATE = 24_000;

const VOICE_BYTES = 510 * 256 * 4;
/** The voices of the languages the worker can phonemize: English, Spanish, Hindi, Italian, Brazilian Portuguese. */
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
  ef_dora: 'f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532',
  em_alex: '27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95',
  em_santa: 'ad43b774e1ca24d05c6161297d8aeb770ac3d29bb95daf516727af5f7d543683',
  hf_alpha: '040be6a4425411cc01fda5fd06693c76bfa78572632852bc8cda9c99232ffb56',
  hf_beta: 'cd83ae0bb9b2e4e4fb92b4973bd8d1822ca0036d3c498bf4fc89aa8e33917cc7',
  hm_omega: 'b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137',
  hm_psi: '644daf88ba8aeb7bd08950bbdcd4453bb280864e49dc4df93fabc6be32e03f37',
  if_sara: '409b69248798fcdc2542330c76953d230710f19b057e59cb82fdc3c4cf71265c',
  im_nicola: 'bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0',
  pf_dora: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee',
  pm_alex: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a',
  pm_santa: '8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede',
};

/**
 * Where the G2P table for Spanish, Hindi, Italian or Brazilian Portuguese lives under
 * the model directory. Each is learned from Kokoro's own espeak-ng readings by
 * the OpenReader iOS `tools/learned-g2p`; no espeak code or data ships.
 */
export function kokoroLearnedG2PFile(language: LearnedLanguage): string {
  return `g2p/${language}.tsv`;
}

interface KokoroFile {
  path: string;
  url: string;
  size: number;
  sha256: string;
}

interface KokoroComponent {
  name: 'Model weights' | 'Voice pack' | 'Pronunciation data';
  files: KokoroFile[];
}

const misakiFile = (name: string, size: number, sha256: string): KokoroFile => ({
  path: `misaki/${name}`,
  url: `${MISAKI_DATA_BASE_URL}/${name}`,
  size,
  sha256,
});

const learnedFile = (language: LearnedLanguage, size: number, sha256: string): KokoroFile => ({
  path: kokoroLearnedG2PFile(language),
  url: `${KOKORO_REPO_URL}/${kokoroLearnedG2PFile(language)}`,
  size,
  sha256,
});

export const KOKORO_COMPONENTS: readonly KokoroComponent[] = [
  {
    name: 'Model weights',
    files: [{
      path: KOKORO_MODEL_FILE,
      url: KOKORO_MODEL_URL,
      size: 325_700_391,
      sha256: 'd81c0d8e89a78a3c17da609404dc7917e26d2d0bfc441eb7c32ddb7e0d3a5197',
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
    name: 'Pronunciation data',
    files: [
      learnedFile('es', 184_339, 'eff1f115e9c082ea6889a295e7fb658e81b4af298d2c54722389391d90bef21e'),
      learnedFile('hi', 163_591, '562797a685ab7148bc6fdff745a7142ab4b27b2471b270747ae6303e8212c0de'),
      learnedFile('it', 363_007, '78a266c9172507fa53c069048fddb2ff05de676d4c73d91ce1f9dfb886ecbd48'),
      learnedFile('pt-br', 586_315, '6aae16e69e46269be8ca8c759fd9e7c9e1e24dbf2c322e68b2063810943573e6'),
      misakiFile('us_gold.json', 3_000_469, 'dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f'),
      misakiFile('us_silver.json', 3_099_517, 'de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475'),
      misakiFile('gb_gold.json', 2_838_552, '29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71'),
      misakiFile('gb_silver.json', 3_663_898, '48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce'),
    ],
  },
];

export function kokoroAssetPath(relativePath: string, modelDir = KOKORO_MODEL_DIR): string {
  return path.join(modelDir, relativePath);
}

export interface KokoroAssetSelection {
  /** Individual voice ids, including every member of a blend. Omitted means none. */
  voices?: readonly string[];
  /** The language used to phonemize the request (the first voice's for a blend). */
  language?: 'us' | 'gb' | LearnedLanguage;
}

function selectedComponents(
  components: readonly KokoroComponent[],
  selection: KokoroAssetSelection = { voices: ['af_heart'], language: 'us' },
): readonly KokoroComponent[] {
  // Setup prepares one usable default voice. Other voices and languages are
  // fetched when selected for synthesis; an empty selection loads only weights.
  const paths = new Set<string>();
  for (const voice of selection.voices ?? []) {
    if (!Object.hasOwn(KOKORO_VOICE_SHA256, voice)) {
      throw new Error(`Local Kokoro has no voice "${voice}"`);
    }
    paths.add(`voices/${voice}.bin`);
  }
  const language = selection.language;
  if (language === 'us' || language === 'gb') {
    paths.add(`misaki/${language}_gold.json`);
    paths.add(`misaki/${language}_silver.json`);
  } else if (language) {
    const file = kokoroLearnedG2PFile(language);
    if (!KOKORO_COMPONENTS.some((component) => component.files.some((entry) => entry.path === file))) {
      throw new Error(`Local Kokoro has no pronunciation data for "${language}"`);
    }
    paths.add(file);
  }
  return components.map((component) => ({
    ...component,
    files: component.name === 'Model weights' ? component.files : component.files.filter((file) => paths.has(file.path)),
  })).filter((component) => component.files.length > 0);
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
 * Makes the selected Kokoro files present and verified (the default voice and
 * US pronunciation when selection is omitted). Explicit components are used
 * as supplied unless a selection is also given. Existing files are checked
 * rather than fetched again; a mismatch is replaced.
 */
export async function ensureKokoroAssetFiles(options: {
  modelDir?: string;
  components?: readonly KokoroComponent[];
  selection?: KokoroAssetSelection;
  fetchImpl?: ModelFetch;
  onProgress?: ModelDownloadProgressHandler;
  signal?: AbortSignal;
} = {}): Promise<void> {
  await downloadKokoroAssetFiles(options);
}

async function downloadKokoroAssetFiles(
  options: NonNullable<Parameters<typeof ensureKokoroAssetFiles>[0]>,
  verified = new Set<string>(),
): Promise<void> {
  const modelDir = options.modelDir ?? KOKORO_MODEL_DIR;
  const components = options.components && !options.selection
    ? options.components
    : selectedComponents(options.components ?? KOKORO_COMPONENTS, options.selection);
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
      if (verified.has(file.path)) continue;
      if (await fileMatches(kokoroAssetPath(file.path, modelDir), file)) verified.add(file.path);
      else absent.push(file);
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
        options.signal?.throwIfAborted();
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
          signal: options.signal,
          onProgress: async ({ downloadedBytes }) => {
            state.downloadedBytes = before + Math.min(file.size, downloadedBytes);
            await report();
          },
        }).catch(async (error: unknown) => {
          await unlink(tmp).catch(() => undefined);
          throw error;
        });
        state.state = 'verifying';
        await report();
        if (!(await fileMatches(tmp, file))) {
          await unlink(tmp).catch(() => undefined);
          throw new Error(`Local Kokoro file failed verification: ${file.path}`);
        }
        await rename(tmp, target);
        verified.add(file.path);
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

const verifiedAssets = new Set<string>();
let downloadTail: Promise<void> = Promise.resolve();
let waitingDownloads = 0;
let download: AbortController | null = null;
const listeners = new Set<ModelDownloadProgressHandler>();

/**
 * With no selection, joins an active download or reuses any usable installed
 * voice; otherwise installs the model, af_heart and US pronunciation data.
 * With a selection, ensures the model and only the requested voices/language.
 * Requests share one serial download queue and verified files; a later language
 * or voice never inherits an earlier request's incomplete readiness. Progress
 * is fanned out to everyone waiting, and cancellation fails queued requests too.
 */
export async function ensureKokoroAssets(
  onProgress?: ModelDownloadProgressHandler,
  selection?: KokoroAssetSelection,
): Promise<void> {
  // Separate registrations even when two callers pass the same callback.
  const listener: ModelDownloadProgressHandler | undefined = onProgress ? (progress) => onProgress(progress) : undefined;
  if (listener) listeners.add(listener);
  let enqueued = false;
  try {
    let components: readonly KokoroComponent[];
    if (selection === undefined) {
      if (download) {
        await downloadTail;
        return;
      }
      // Size-based inventory chooses a usable baseline but cannot prove file
      // integrity. Send that baseline through normal checksum verification.
      components = (await readKokoroAssetInventory(KOKORO_MODEL_DIR)).baseline;
      // A demand request may have started while disk status was being read.
      if (download) {
        await downloadTail;
        return;
      }
    } else {
      components = selectedComponents(KOKORO_COMPONENTS, selection);
    }
    if (components.every((component) => component.files.every((file) => verifiedAssets.has(file.path)))) return;
    const controller = download ??= new AbortController();
    waitingDownloads += 1;
    enqueued = true;
    // A failed selection must not prevent a different request from trying. A
    // shared cancel keeps this controller aborted until the queue drains.
    const pending = downloadTail.catch(() => undefined).then(async () => {
      controller.signal.throwIfAborted();
      await downloadKokoroAssetFiles({
        components,
        signal: controller.signal,
        onProgress: async (progress) => {
          await Promise.all([...listeners].map((listener) => listener(progress)));
        },
      }, verifiedAssets);
    });
    downloadTail = pending;
    await pending;
  } finally {
    if (listener) listeners.delete(listener);
    if (enqueued) {
      waitingDownloads -= 1;
      if (waitingDownloads === 0) download = null;
    }
  }
}

/** Stops the download in progress in this process, failing everyone waiting on it. */
export function cancelKokoroDownload(): boolean {
  if (!download) return false;
  download.abort(new Error('The Kokoro download was canceled.'));
  return true;
}

export function isKokoroDownloading(): boolean {
  return download !== null;
}

export interface KokoroComponentStatus {
  name: KokoroComponent['name'] | 'Additional voices' | 'Additional pronunciation data';
  totalBytes: number;
  installedBytes: number;
}

/**
 * The three required components describe one usable voice: prefer af_heart/US,
 * otherwise the first complete voice in sorted id order. If none is complete,
 * show the default baseline's missing files. Installed optional files are added
 * as inventory components with equal total/installed bytes, so absent optional
 * data never makes a usable installation partial and Remove counts all files.
 * Sizes alone are checked here: files reach final paths only after verification.
 */
async function readKokoroAssetInventory(modelDir: string) {
  const installed = new Set<string>();
  await Promise.all(KOKORO_COMPONENTS.map(async (component) => {
    for (const file of component.files) {
      const info = await stat(kokoroAssetPath(file.path, modelDir)).catch(() => null);
      if (info?.size === file.size) installed.add(file.path);
    }
  }));
  const complete = (components: readonly KokoroComponent[]) =>
    components.every((component) => component.files.every((file) => installed.has(file.path)));
  let baseline = selectedComponents(KOKORO_COMPONENTS);
  if (!complete(baseline)) {
    const languages: Record<string, KokoroAssetSelection['language']> = {
      a: 'us', b: 'gb', e: 'es', i: 'it', p: 'pt-br', h: 'hi',
    };
    for (const voice of Object.keys(KOKORO_VOICE_SHA256).sort()) {
      const language = languages[voice[0]!];
      if (!language || !installed.has(`voices/${voice}.bin`)) continue;
      const candidate = selectedComponents(KOKORO_COMPONENTS, { voices: [voice], language });
      if (complete(candidate)) {
        baseline = candidate;
        break;
      }
    }
  }
  return { installed, baseline };
}

/** Size-based status; ensuring assets separately verifies the chosen baseline. */
export async function kokoroAssetStatus(modelDir = KOKORO_MODEL_DIR): Promise<KokoroComponentStatus[]> {
  const { installed, baseline } = await readKokoroAssetInventory(modelDir);
  const inventory = KOKORO_COMPONENTS.map((component, index) => {
    const required = baseline[index]!.files;
    const requiredPaths = new Set(required.map((file) => file.path));
    let installedBytes = 0;
    let additionalBytes = 0;
    for (const file of component.files) {
      if (!installed.has(file.path)) continue;
      if (requiredPaths.has(file.path)) installedBytes += file.size;
      else additionalBytes += file.size;
    }
    return {
      baseline: {
        name: component.name,
        totalBytes: required.reduce((sum, file) => sum + file.size, 0),
        installedBytes,
      },
      additional: additionalBytes > 0 ? [{
        name: component.name === 'Voice pack' ? 'Additional voices' as const : 'Additional pronunciation data' as const,
        totalBytes: additionalBytes,
        installedBytes: additionalBytes,
      }] : [],
    };
  });
  return [...inventory.map((component) => component.baseline), ...inventory.flatMap((component) => component.additional)];
}

/** Deletes the downloaded files. The caller makes sure nothing is reading them. */
export async function removeKokoroAssetFiles(modelDir = KOKORO_MODEL_DIR): Promise<void> {
  if (download) throw new KokoroDownloadInProgressError();
  verifiedAssets.clear();
  await rm(modelDir, { recursive: true, force: true });
}

export class KokoroDownloadInProgressError extends Error {
  constructor() {
    super('Kokoro is downloading. Cancel the download before removing it.');
    this.name = 'KokoroDownloadInProgressError';
  }
}
