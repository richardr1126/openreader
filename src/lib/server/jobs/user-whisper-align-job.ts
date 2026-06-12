import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { WhisperAlignRequest } from '@/lib/server/compute-worker/protocol';
import type { TTSSentenceAlignment } from '@/types/tts';

export type UserWhisperAlignJobRequest = WhisperAlignRequest & {
  sentenceIndex?: number;
};

export async function userWhisperAlignJob(input: UserWhisperAlignJobRequest): Promise<TTSSentenceAlignment | null> {
  const { alignments } = await getComputeWorkerClient().alignWords({
    audioObjectKey: input.audioObjectKey,
    text: input.text,
    cacheKey: input.cacheKey,
    lang: input.lang,
  });

  const first = alignments[0];
  if (!first) return null;

  if (typeof input.sentenceIndex === 'number' && Number.isFinite(input.sentenceIndex)) {
    return { ...first, sentenceIndex: input.sentenceIndex };
  }
  return first;
}
