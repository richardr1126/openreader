// Whisper alignment of one audio window on its own thread (see whisper-thread.ts):
// the log-mel spectrogram, the encoder, the token-by-token decoder and the
// cross-attention timing all run here, so none of it blocks the event loop.
import { workerData } from 'node:worker_threads';
import { configureComputeJobConcurrency } from '../../infrastructure/config.ts';
import { serveInferenceThread } from '../serve-inference-thread.mjs';
import { runWhisperOnnx } from './align.ts';

configureComputeJobConcurrency(workerData.jobConcurrency);
serveInferenceThread(
  () => undefined,
  (window) => runWhisperOnnx(window.samples, { lang: window.lang, textHint: window.textHint },
    window.numFrames, window.textShare, window.deadlineMs, window.timeoutMs),
);
