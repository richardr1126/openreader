import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { rateLimiter, RATE_LIMITS, isTtsRateLimitEnabled } from '@/lib/server/rate-limit/rate-limiter';
import { headers } from 'next/headers';
import { isAuthEnabled } from '@/lib/server/auth/config';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { nextUtcMidnightTimestampMs } from '@/lib/shared/timestamps';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

function getUtcResetTimeMs(): number {
  return nextUtcMidnightTimestampMs();
}

export async function GET(req: NextRequest) {
  try {
    const ttsRateLimitEnabled = isTtsRateLimitEnabled();

    // If auth is not enabled, return unlimited status
    if (!isAuthEnabled() || !auth) {
      const resetTimeMs = getUtcResetTimeMs();
      return NextResponse.json({
        allowed: true,
        currentCount: 0,
        // Avoid Infinity in JSON (serializes to null). This value is never shown
        // because authEnabled=false, but we keep it finite to prevent surprises.
        limit: Number.MAX_SAFE_INTEGER,
        remainingChars: Number.MAX_SAFE_INTEGER,
        resetTimeMs,
        userType: 'unauthenticated',
        authEnabled: false
      });
    }

    // Get session from auth
    const session = await auth.api.getSession({
      headers: await headers()
    });

    // No session means unauthenticated
    if (!session?.user) {
      const resetTimeMs = getUtcResetTimeMs();
      return NextResponse.json({
        allowed: true,
        currentCount: 0,
        limit: ttsRateLimitEnabled ? RATE_LIMITS.ANONYMOUS : Number.MAX_SAFE_INTEGER,
        remainingChars: ttsRateLimitEnabled ? RATE_LIMITS.ANONYMOUS : Number.MAX_SAFE_INTEGER,
        resetTimeMs,
        userType: 'unauthenticated',
        authEnabled: true
      });
    }

    const isAnonymous = Boolean((session.user as { isAnonymous?: boolean }).isAnonymous);

    const ip = getClientIp(req);
    const device = isTtsRateLimitEnabled() ? (isAnonymous ? getOrCreateDeviceId(req) : null) : null;

    const result = await rateLimiter.getCurrentUsage(
      {
        id: session.user.id,
        isAnonymous,
      },
      {
        deviceId: device?.deviceId ?? null,
        ip,
      }
    );

    const response = NextResponse.json({
      allowed: result.allowed,
      currentCount: result.currentCount,
      limit: result.limit,
      remainingChars: result.remainingChars,
      resetTimeMs: result.resetTimeMs,
      userType: isAnonymous ? 'anonymous' : 'authenticated',
      authEnabled: true
    });

    if (device?.didCreate) {
      setDeviceIdCookie(response, device.deviceId);
    }

    return response;
  } catch (error) {
    serverLogger.error({
      event: 'rate_limit.status.get.failed',
      error: errorToLog(error),
    }, 'Failed to get rate limit status');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to get rate limit status',
      normalize: { code: 'RATE_LIMIT_STATUS_GET_FAILED', errorClass: 'db' },
    });
  }
}
