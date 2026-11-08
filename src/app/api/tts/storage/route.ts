import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { getStorageUsage, storageCapBytes } from '@/lib/server/storage/usage';
import { getRuntimeConfig } from '@/lib/server/admin/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Library-wide storage totals for the signed-in user. */
export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage', request });
  try {
    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId!;
    const usage = (await getStorageUsage([userId])).get(userId)!;
    return NextResponse.json({
      ...usage, capBytes: storageCapBytes(await getRuntimeConfig(), Boolean(ctxOrRes.user?.isAnonymous)),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.library_usage_failed',
      msg: 'Failed to measure library storage',
      apiErrorMessage: 'Failed to measure library storage',
      normalize: { code: 'TTS_STORAGE_USAGE_FAILED', errorClass: 'storage' },
    });
  }
}
