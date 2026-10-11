import { NextRequest, NextResponse } from 'next/server';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { errorResponse } from '@/lib/server/errors/next-response';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import {
  AdminProviderError,
  decryptedKeyFor,
  getAdminProviderById,
  validateProviderType,
} from '@/lib/server/admin/providers';
import { runProviderCheck, type ProviderCheckDraft, type ProviderCheckSaved } from '@/lib/server/admin/provider-check';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { ProviderCheckItem } from '@/lib/shared/provider-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Checks the provider described by the admin dialog. When `providerId` names
 * a saved provider, a blank key falls back to its stored key, and an unchanged
 * provider also speaks a sample through the worker.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const draft: ProviderCheckDraft = {
      providerType: validateProviderType(body.providerType),
      baseUrl: text(body.baseUrl),
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      defaultModel: text(body.defaultModel),
      defaultInstructions: text(body.defaultInstructions),
    };

    let saved: ProviderCheckSaved | null = null;
    const providerId = text(body.providerId);
    if (providerId) {
      const record = await getAdminProviderById(providerId);
      if (!record) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      const keyChanged = draft.apiKey.length > 0;
      const sameEndpoint = record.providerType === draft.providerType
        && (record.baseUrl ?? '') === draft.baseUrl;
      if (!keyChanged) {
        // The stored key is write-only; never send it to an endpoint the admin changed.
        if (!sameEndpoint && record.apiKeyLast4) {
          const checks: ProviderCheckItem[] = [{
            id: 'settings',
            label: 'Settings',
            status: 'error',
            detail: 'Enter the API key again to check a changed provider type or base URL.',
          }];
          return NextResponse.json({ checks }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (sameEndpoint) draft.apiKey = await decryptedKeyFor(record);
      }
      saved = {
        slug: record.slug,
        enabled: record.enabled,
        matchesDraft: !keyChanged
          && sameEndpoint
          && (record.defaultModel ?? '') === draft.defaultModel
          && (record.defaultInstructions ?? '') === draft.defaultInstructions,
      };
    }

    const checks = await runProviderCheck(draft, saved, {
      fetch,
      resolveVoices,
      workerAvailable: isComputeWorkerAvailable,
      synthesizePreview: (input, signal) => new ComputeWorkerClient().synthesizeTtsVoicePreview(input, { signal }),
    }, req.signal);
    return NextResponse.json({ checks }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdminProviderError) {
      return errorResponse(error, {
        apiErrorMessage: error.message,
        normalize: {
          code: 'ADMIN_PROVIDERS_CHECK_REQUEST_FAILED',
          errorClass: 'validation',
          httpStatus: error.status,
        },
      });
    }
    serverLogger.error({
      event: 'admin.providers.check.failed',
      error: errorToLog(error),
    }, 'Admin provider check failed');
    return errorResponse(error, {
      apiErrorMessage: 'Provider check failed',
      normalize: { code: 'ADMIN_PROVIDERS_CHECK_FAILED', errorClass: 'unknown' },
    });
  }
}
