import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cloneComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import type { ComputeOperation } from '@/lib/server/compute-worker/protocol';

const admissionMocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  activate: vi.fn(),
  finish: vi.fn(),
  getOperation: vi.fn(),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  getComputeWorkerClient: () => ({ getOperation: admissionMocks.getOperation }),
}));

vi.mock('@/lib/server/compute-limits/admission', () => ({
  reserveComputeAdmission: admissionMocks.reserve,
  activateComputeAdmission: admissionMocks.activate,
  finishComputeAdmission: admissionMocks.finish,
}));

import { createAdmittedComputeOperation } from '@/lib/server/compute-limits/run-admitted';

const operation = {
  opId: 'operation-1',
  status: 'queued',
} as ComputeOperation;

describe('admitted compute operation creation', () => {
  beforeEach(() => {
    admissionMocks.reserve.mockReset().mockResolvedValue({
      allowed: true,
      admissionId: 'admission-1',
      state: 'reserved',
      idempotent: false,
      retryAfterMs: 0,
    });
    admissionMocks.activate.mockReset().mockResolvedValue(undefined);
    admissionMocks.finish.mockReset().mockResolvedValue(undefined);
    admissionMocks.getOperation.mockReset().mockResolvedValue(operation);
  });

  test('keeps the admission active when operation linkage fails after creation', async () => {
    admissionMocks.activate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('database unavailable'));
    const create = vi.fn().mockResolvedValue(operation);

    await expect(createAdmittedComputeOperation({
      policy: cloneComputeLimitPolicyDocument(),
      action: 'pdf_layout',
      requestKey: 'request-1',
      subject: { userId: 'user-1', isAnonymous: false },
      create,
    })).rejects.toThrow('database unavailable');

    expect(create).toHaveBeenCalledOnce();
    expect(admissionMocks.activate).toHaveBeenCalledTimes(4);
    expect(admissionMocks.activate).toHaveBeenLastCalledWith(expect.objectContaining({
      admissionId: 'admission-1',
      operationId: 'operation-1',
    }));
    expect(admissionMocks.finish).not.toHaveBeenCalled();
  });

  test('cancels the admission when worker operation creation fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('worker unavailable'));

    await expect(createAdmittedComputeOperation({
      policy: cloneComputeLimitPolicyDocument(),
      action: 'pdf_layout',
      requestKey: 'request-2',
      subject: { userId: 'user-1', isAnonymous: false },
      create,
    })).rejects.toThrow('worker unavailable');

    expect(admissionMocks.finish).toHaveBeenCalledWith({
      admissionId: 'admission-1',
      state: 'cancelled',
    });
  });

  test('releases the slot when the job completed before its admission was linked', async () => {
    admissionMocks.getOperation.mockResolvedValue({ ...operation, status: 'succeeded' });
    await createAdmittedComputeOperation({
      policy: cloneComputeLimitPolicyDocument(),
      action: 'pdf_layout',
      requestKey: 'request-3',
      subject: { userId: 'user-1', isAnonymous: false },
      create: async () => operation,
    });
    expect(admissionMocks.activate).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: operation.opId }));
    expect(admissionMocks.getOperation).toHaveBeenCalledWith(operation.opId, expect.anything());
    expect(admissionMocks.finish).toHaveBeenCalledWith({ admissionId: 'admission-1', state: 'finished' });
  });
});
