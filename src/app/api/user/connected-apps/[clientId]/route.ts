import { NextRequest, NextResponse } from 'next/server';
import { disconnectApp, oauthCookieRequest } from '@/lib/server/auth/connected-apps';
export const dynamic = 'force-dynamic';
export function DELETE(request: NextRequest, context: { params: Promise<{ clientId: string }> }) {
  return oauthCookieRequest(request, async principal => {
    await disconnectApp(principal.userId, (await context.params).clientId);
    return new NextResponse(null, { status: 204 });
  });
}
