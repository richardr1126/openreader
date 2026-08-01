import type { ReaderPayload } from '@/types/reader-bootstrap';

/** Immutable identity for one server-authoritative reader surface. */
export function readerSurfaceKey(payload: ReaderPayload): string {
  return [
    payload.readerType,
    payload.documentId,
    payload.document.contentVersion ?? payload.document.id,
    payload.plan.planId ?? 'missing-plan-id',
    payload.plan.planSignature ?? 'missing-plan-signature',
  ].join(':');
}
