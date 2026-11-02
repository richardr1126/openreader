import { NextRequest, NextResponse } from 'next/server';
import { oauthCookieRequest, oauthRequestInfo } from '@/lib/server/auth/connected-apps';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return oauthCookieRequest(request, async () => NextResponse.json(await oauthRequestInfo(request)));
}
