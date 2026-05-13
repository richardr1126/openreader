import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { isAuthEnabled } from '@/lib/server/auth/config';
import { listAdminProviders, toPublic } from '@/lib/server/admin/providers';

export const dynamic = 'force-dynamic';

/**
 * Public list of admin-configured TTS providers. Auth-gated when auth is
 * enabled. Never returns keys, base URLs, or ciphertext — only the data the
 * client needs to render the provider picker.
 */
export async function GET(req: NextRequest) {
  if (isAuthEnabled()) {
    const session = await auth?.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const all = await listAdminProviders();
    const visible = all.filter((p) => p.enabled).map(toPublic);
    return NextResponse.json({ providers: visible });
  } catch (error) {
    console.warn('[tts/shared-providers] list failed:', error);
    return NextResponse.json({ providers: [] });
  }
}
