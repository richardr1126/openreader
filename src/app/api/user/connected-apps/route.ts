import { NextRequest, NextResponse } from 'next/server';
import { listConnectedApps, oauthCookieRequest } from '@/lib/server/auth/connected-apps';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return oauthCookieRequest(request, async principal => NextResponse.json(await listConnectedApps(principal.userId)));
}
