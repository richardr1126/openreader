import { getGutendexSettings } from '@/lib/server/admin/gutendex-settings';
import { createServerAppError } from '@/lib/server/errors/contract';

/**
 * Project Gutenberg catalog, searched through a Gutendex server.
 *
 * Both halves run on the server. gutenberg.org sends no CORS headers, so the
 * browser cannot fetch a book itself; and a Vercel Function cannot hand one
 * back either, because responses are capped at 4.5 MB and illustrated EPUBs
 * run past 25 MB. So the import downloads the book here and stages it as a
 * temp upload, and the browser finalizes it like any other upload, which keeps
 * folders, previews and the upload receipts on the one path.
 */

const EPUB_MIME = 'application/epub+zip';
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

/** Book bytes are only ever fetched from Gutenberg itself. The format URL comes
 * from the Gutendex response, and pinning the host means a misconfigured or
 * hostile catalog server cannot point this route at anything else. */
const GUTENBERG_HOSTS = new Set(['www.gutenberg.org', 'gutenberg.org']);

export type GutenbergBook = {
  id: number;
  title: string;
  authors: string[];
  languages: string[];
  downloadCount: number;
  coverUrl: string | null;
};

export type GutenbergSearchPage = {
  count: number;
  page: number;
  hasNextPage: boolean;
  books: GutenbergBook[];
};

type GutendexPerson = { name?: unknown };
type GutendexBook = {
  id?: unknown;
  title?: unknown;
  authors?: unknown;
  languages?: unknown;
  download_count?: unknown;
  formats?: unknown;
};

function catalogUnavailable(message: string, cause?: unknown) {
  return createServerAppError({
    code: 'GUTENBERG_CATALOG_UNAVAILABLE',
    message,
    errorClass: 'upstream',
    ...(cause !== undefined ? { cause } : {}),
  });
}

async function catalogRequest(path: string, params?: URLSearchParams): Promise<unknown> {
  const settings = await getGutendexSettings();
  if (!settings.enabled) {
    throw createServerAppError({
      code: 'GUTENBERG_CATALOG_DISABLED',
      message: 'The Project Gutenberg catalog is turned off on this server',
      errorClass: 'permission',
      httpStatus: 404,
    });
  }

  const url = new URL(`${settings.serverUrl}/books/${path}`);
  if (params) url.search = params.toString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;

  // Redirects are followed by hand because fetch strips Authorization on a
  // cross-origin hop but keeps a custom X-API-Key, so a catalog server could
  // otherwise forward the key to another host or down to plain http.
  let current = url;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (error) {
      throw catalogUnavailable('The Project Gutenberg catalog did not respond', error);
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    if (hop >= MAX_REDIRECTS) throw catalogUnavailable('Too many redirects from the Gutendex server');
    const next = new URL(location, current);
    if (next.host !== url.host || (current.protocol === 'https:' && next.protocol !== 'https:')) {
      throw catalogUnavailable('The Gutendex server redirected away from its configured address');
    }
    current = next;
  }
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw catalogUnavailable('The Gutendex server rejected its API key. Check it in Settings → Catalog.');
  }
  if (!response.ok) {
    throw catalogUnavailable(`The Project Gutenberg catalog returned ${response.status}`);
  }
  return response.json();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function formatsOf(book: GutendexBook): Record<string, string> {
  if (!book.formats || typeof book.formats !== 'object') return {};
  return Object.fromEntries(
    Object.entries(book.formats as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Gutenberg keeps authors "Surname, Forenames"; the library shows them read
 * the way a cover prints them. */
function displayName(name: string): string {
  const parts = name.split(', ');
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}

function toBook(raw: GutendexBook): GutenbergBook | null {
  if (typeof raw.id !== 'number' || typeof raw.title !== 'string') return null;
  const authors = Array.isArray(raw.authors)
    ? (raw.authors as GutendexPerson[]).flatMap((author) =>
      typeof author?.name === 'string' ? [displayName(author.name)] : [])
    : [];
  return {
    id: raw.id,
    title: raw.title,
    authors,
    languages: stringList(raw.languages),
    downloadCount: typeof raw.download_count === 'number' ? raw.download_count : 0,
    coverUrl: formatsOf(raw)['image/jpeg'] ?? null,
  };
}

export async function searchGutenberg(input: { search: string; page: number }): Promise<GutenbergSearchPage> {
  const params = new URLSearchParams();
  const search = input.search.trim();
  if (search) params.set('search', search);
  // Gutendex matches mime_type as a prefix. Only books that can be imported
  // are worth listing, and nearly all of Gutenberg has an EPUB.
  params.set('mime_type', 'application/epub');
  if (input.page > 1) params.set('page', String(input.page));

  const data = await catalogRequest('', params) as { count?: unknown; next?: unknown; results?: unknown } | null;
  if (!data) return { count: 0, page: input.page, hasNextPage: false, books: [] };
  const results = Array.isArray(data.results) ? data.results as GutendexBook[] : [];
  return {
    count: typeof data.count === 'number' ? data.count : results.length,
    page: input.page,
    hasNextPage: typeof data.next === 'string' && data.next.length > 0,
    books: results.flatMap((raw) => {
      const book = toBook(raw);
      return book ? [book] : [];
    }),
  };
}

function isGutenbergUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && GUTENBERG_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function epubFileName(book: GutenbergBook): string {
  const safe = book.title
    .split(/[\r\n]/)[0]
    .replace(/[/\\?%*:|"<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${safe || `Gutenberg ${book.id}`}.epub`;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  if (!response.body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function tooLarge(maxBytes: number) {
  return createServerAppError({
    code: 'GUTENBERG_BOOK_TOO_LARGE',
    message: `This book is larger than this server's ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`,
    errorClass: 'validation',
    httpStatus: 413,
  });
}

/** Follows redirects by hand so every hop is held to the Gutenberg hosts;
 * `/ebooks/<id>.epub3.images` answers with a 302 into `/cache/epub/`. */
async function fetchFromGutenberg(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isGutenbergUrl(current)) throw catalogUnavailable('The catalog pointed outside Project Gutenberg');
    const response = await fetch(current, { redirect: 'manual', signal, cache: 'no-store' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw catalogUnavailable(`Project Gutenberg returned ${response.status} for this book`);
    return response;
  }
  throw catalogUnavailable('Too many redirects while downloading the book');
}

export async function downloadGutenbergEpub(
  id: number,
  maxBytes: number,
): Promise<{ book: GutenbergBook; name: string; bytes: Buffer }> {
  // The trailing slash matters: Django answers `/books/1342` with a 301 to
  // `/books/1342/`, which costs a round trip and took 25 s on gutendex.com.
  const raw = await catalogRequest(`${id}/`) as GutendexBook | null;
  const book = raw ? toBook(raw) : null;
  if (!raw || !book) {
    throw createServerAppError({
      code: 'GUTENBERG_BOOK_NOT_FOUND',
      message: 'That book is not in the Project Gutenberg catalog',
      errorClass: 'validation',
      httpStatus: 404,
    });
  }
  const epubUrl = formatsOf(raw)[EPUB_MIME];
  if (!epubUrl) {
    throw createServerAppError({
      code: 'GUTENBERG_BOOK_NO_EPUB',
      message: 'Project Gutenberg has no EPUB of this book',
      errorClass: 'validation',
      httpStatus: 422,
    });
  }

  let bytes: Buffer;
  try {
    const response = await fetchFromGutenberg(epubUrl, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    bytes = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof Error && error.name === 'ServerAppError') throw error;
    throw catalogUnavailable('Downloading the book from Project Gutenberg failed', error);
  }
  if (bytes.byteLength === 0) throw catalogUnavailable('Project Gutenberg returned an empty file');
  return { book, name: epubFileName(book), bytes };
}
