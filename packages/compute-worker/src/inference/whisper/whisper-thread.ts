import { getComputeJobConcurrency } from '../../infrastructure/config';
import { createInferenceThread } from '../inference-thread';
import type { WhisperWord } from './timestamps';

export interface WhisperWindowRequest {
  /** One 30-second window of 16 kHz mono samples; the thread takes its buffer. */
  samples: Float32Array;
  lang?: string;
  textHint?: string;
  numFrames: number;
  textShare: number;
  deadlineMs: number;
  timeoutMs: number;
}

const thread = createInferenceThread('inference/whisper/whisper-thread-worker',
  () => ({ jobConcurrency: getComputeJobConcurrency() }));

/** Words heard in one window. The model files must already be downloaded. */
export function alignWhisperWindow(request: WhisperWindowRequest): Promise<WhisperWord[]> {
  return thread.call<WhisperWord[]>(request, [request.samples.buffer as ArrayBuffer]);
}
