import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { fetchAndParseUrl } from '@/lib/server/documents/web-loader';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate user request
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    // 2. Validate URL body parameter
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { url } = body;
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid url parameter' }, { status: 400 });
    }

    // 3. Fetch webpage, scrape readable elements, convert to markdown
    const result = await fetchAndParseUrl(url);

    // 4. Return title and parsed markdown content
    return NextResponse.json(result);
  } catch (error) {
    serverLogger.error(
      {
        event: 'documents.import-url.failed',
        error: errorToLog(error),
      },
      'Failed to import and parse document from web URL'
    );

    const errorMessage = error instanceof Error ? error.message : 'Failed to import URL';
    
    // Check if it's a validation error or network error to set suitable status codes
    const isValidationError =
      errorMessage.includes('forbidden') ||
      errorMessage.includes('disallowed by policy') ||
      errorMessage.includes('Invalid URL') ||
      errorMessage.includes('Only HTTP') ||
      errorMessage.includes('exceeds the maximum') ||
      errorMessage.includes('Unsupported content type');

    return NextResponse.json(
      { error: errorMessage },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
