import type { TtsPlaybackPlanJobRequest, TtsPlaybackPlanJobResult } from '../../operations/contracts';
import type { JobHandlerContext } from '../context';
import { resolveAndPersistTtsPlaybackPlan } from './plan';
import { ttsPlaybackPlanRequestSchema, type TtsPlaybackPlanCapableRequest } from './schemas';

export function createTtsPlaybackPlanHandler(input: JobHandlerContext) {
  return async function runTtsPlaybackPlan(payload: TtsPlaybackPlanJobRequest, queueWaitMs: number): Promise<TtsPlaybackPlanJobResult> {
    const parsed = ttsPlaybackPlanRequestSchema.parse(payload);
    const startedAt = Date.now();
    const plan = await resolveAndPersistTtsPlaybackPlan({
      request: { ...parsed, sessionId: `plan:${parsed.documentId}:${parsed.settingsHash}` } satisfies TtsPlaybackPlanCapableRequest,
      storage: input.storage,
      s3Prefix: input.s3Prefix,
    });
    return {
      planObjectKey: plan.planObjectKey,
      planSignature: plan.planSignature,
      startOrdinal: plan.startOrdinal,
      plannedCount: plan.plannedSegments.length,
      timing: { queueWaitMs, computeMs: Date.now() - startedAt },
    };
  };
}
