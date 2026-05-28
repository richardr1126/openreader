import { getCompute } from '@/lib/server/compute';
import type { WhisperAlignJobRequest } from '@openreader/compute-core/api-contracts';
import type { TTSSentenceAlignment } from '@/types/tts';

export type UserWhisperAlignJobRequest = WhisperAlignJobRequest & {
  sentenceIndex?: number;
};

export async function userWhisperAlignJob(input: UserWhisperAlignJobRequest): Promise<TTSSentenceAlignment | null> {
  const compute = await getCompute();
  const { alignments } = await compute.alignWords({
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
