import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isGutenbergLanguage, searchGutenberg } from '@/lib/server/documents/gutenberg';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';
// An uncached Gutendex query can take most of the catalog's 100 s timeout.
export const maxDuration = 120;

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

    const language = req.nextUrl.searchParams.get('language') ?? '';
    if (!isGutenbergLanguage(language)) {
      return NextResponse.json({ error: 'Invalid language' }, { status: 400 });
    }

    const result = await searchGutenberg({ search, page, language });
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
