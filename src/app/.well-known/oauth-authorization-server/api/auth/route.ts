import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { getAuth } from '@/lib/server/auth/auth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return oauthProviderAuthServerMetadata(await getAuth())(request);
}
