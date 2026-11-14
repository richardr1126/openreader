import {
  COMPUTE_ADMISSION_ACTION_HEADER,
  COMPUTE_ADMISSION_FINISHED_AT_HEADER,
  parseTtsSynthesisConsumeResponse,
  type ComputeAdmissionTerminalRequest,
  type ComputeTerminalAdmissionAction,
  type TtsSynthesisConsumeRequest,
  type TtsSynthesisConsumeResponse,
} from '@openreader/runtime-config/compute-limit-broker';
import {
  getComputeLimitBrokerConfig,
  getComputeLimitCompletionBrokerConfig,
} from '../infrastructure/credential-broker-config';

export async function consumeTtsSynthesisUsage(
  request: TtsSynthesisConsumeRequest,
  signal?: AbortSignal,
): Promise<TtsSynthesisConsumeResponse> {
  const config = getComputeLimitBrokerConfig();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('compute limit broker timeout')), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Compute limit broker rejected request (${response.status})`);
    const parsed = parseTtsSynthesisConsumeResponse(body);
    if (!parsed) throw new Error('Compute limit broker returned an invalid response');
    return parsed;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function notifyComputeAdmissionTerminal(
  request: ComputeAdmissionTerminalRequest,
  admissionAction?: ComputeTerminalAdmissionAction,
  finishedAt?: number,
): Promise<void> {
  const config = getComputeLimitCompletionBrokerConfig();
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(admissionAction ? { [COMPUTE_ADMISSION_ACTION_HEADER]: admissionAction } : {}),
      ...(finishedAt === undefined ? {} : { [COMPUTE_ADMISSION_FINISHED_AT_HEADER]: String(finishedAt) }),
    },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Compute admission completion broker rejected request (${response.status})`);
}
