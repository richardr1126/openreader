import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { searchGutenberg } from '@/lib/server/documents/gutenberg';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

const MAX_SEARCH_LENGTH = 200;

/** Proxies the catalog so the Gutendex API key never reaches the browser. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuthContext(req);
    if (auth instanceof Response) return auth;

    const search = (req.nextUrl.searchParams.get('search') ?? '').slice(0, MAX_SEARCH_LENGTH);
    const page = Number(req.nextUrl.searchParams.get('page') ?? '1');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
    }

    const result = await searchGutenberg({ search, page });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'gutenberg.search.failed',
      msg: 'Failed to search the Project Gutenberg catalog',
      normalize: { code: 'GUTENBERG_SEARCH_FAILED', errorClass: 'upstream' },
    });
  }
}
