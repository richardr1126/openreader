import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { fetchExternal } from '@/lib/server/external-fetch';
import { normalizeAuthor, normalizeLanguage } from '@/lib/server/documents/import-metadata';

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
// Long enough for a large PDF; a web page normally answers in well under it.
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** File types a link may return as-is, by extension, with the content types that name them. */
const FILE_TYPES: { extension: string; contentTypes: string[]; magic?: string }[] = [
  { extension: 'pdf', contentTypes: ['application/pdf', 'application/x-pdf'], magic: '%PDF-' },
  { extension: 'epub', contentTypes: ['application/epub+zip'], magic: 'PK' },
  { extension: 'docx', contentTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], magic: 'PK' },
  { extension: 'md', contentTypes: ['text/markdown', 'text/x-markdown'] },
  { extension: 'txt', contentTypes: ['text/plain'] },
];
/** Servers that do not say what a file is; its name decides. */
const GENERIC_TYPES = ['application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/force-download'];
const NAMED_EXTENSIONS: Record<string, string> = { pdf: 'pdf', epub: 'epub', docx: 'docx', md: 'md', markdown: 'md', mdown: 'md', mkd: 'md', txt: 'txt' };

const mediaType = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();
const isPage = (type: string) => type === 'text/html' || type === 'application/xhtml+xml';

export type UrlSource =
  | { kind: 'page'; title: string; content: string; author: string | null; language: string | null }
  | { kind: 'file'; bytes: Buffer; name: string };

/** The file name a response offers: Content-Disposition first, then the last part of its URL. */
function offeredName(contentDisposition: string | null, finalUrl: string): string {
  const encoded = contentDisposition?.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = contentDisposition?.match(/filename\s*=\s*"?([^";]+)"?/)?.[1];
  if (plain?.trim()) return plain.trim();
  try {
    const last = new URL(finalUrl).pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

function extensionOf(name: string): string | undefined {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? NAMED_EXTENSIONS[match[1]] : undefined;
}

/** What kind of document a response is, or null for a web page. */
function fileExtension(type: string, name: string): string | null {
  if (isPage(type)) return null;
  const named = extensionOf(name);
  if (GENERIC_TYPES.includes(type)) {
    if (named) return named;
    throw new Error('The link did not say what kind of file it is. Link to a web page, PDF, EPUB, DOCX, Markdown or text file.');
  }
  // A plain-text server often sends Markdown as text/plain.
  if (type === 'text/plain' && named === 'md') return 'md';
  const known = FILE_TYPES.find(file => file.contentTypes.includes(type));
  if (!known) throw new Error('Unsupported content type. Link to a web page, PDF, EPUB, DOCX, Markdown or text file.');
  return known.extension;
}

function acceptsContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return isPage(type) || GENERIC_TYPES.includes(type) || FILE_TYPES.some(file => file.contentTypes.includes(type));
}

/** The stored name: the offered (or requested) name, with the extension of what the link returned. */
function fileName(offered: string, extension: string): string {
  const base = offered.replace(/\.(pdf|epub|docx|md|markdown|mdown|mkd|txt|html?)$/i, '').trim();
  return `${base.slice(0, 200) || 'document'}.${extension}`;
}

/**
 * Fetches a link for import. A document file (PDF, EPUB, DOCX, Markdown or
 * text) is kept as it is, up to `maxFileBytes`; a web page becomes Markdown,
 * up to 2 MB of HTML.
 */
export async function fetchUrlSource(urlStr: string, maxFileBytes: number): Promise<UrlSource> {
  // The AntiSSRF agent validates the destination (and every redirect hop) at connection time.
  const response = await fetchExternal(urlStr, {
    maxBytes: contentType => (isPage(mediaType(contentType)) ? PAGE_MAX_BYTES : maxFileBytes),
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    accept: 'text/html,application/xhtml+xml,application/pdf,application/epub+zip,text/markdown,text/plain;q=0.9,*/*;q=0.8',
    acceptsContentType,
    messages: {
      status: status => `Failed to fetch the link (status ${status})`,
      contentType: 'Unsupported content type. Link to a web page, PDF, EPUB, DOCX, Markdown or text file.',
      tooLarge: 'The linked file is larger than this instance allows. Web pages are limited to 2 MB.',
      tooManyRedirects: 'Too many redirects while fetching the link.',
    },
  });
  const offered = offeredName(response.contentDisposition, response.finalUrl);
  const extension = fileExtension(mediaType(response.contentType), offered);
  if (!extension) return { kind: 'page', ...parsePage(response.body, response.finalUrl) };
  const magic = FILE_TYPES.find(file => file.extension === extension)?.magic;
  if (magic && !response.body.subarray(0, magic.length).equals(Buffer.from(magic))) {
    throw new Error(`The link did not return a valid ${extension.toUpperCase()} file.`);
  }
  if (response.body.length === 0) throw new Error('The linked file is empty.');
  return { kind: 'file', bytes: response.body, name: fileName(offered, extension) };
}

/** Extracts readable content from a web page and converts it to Markdown. */
function parsePage(body: Buffer, finalUrl: string): { title: string; content: string; author: string | null; language: string | null } {
  const html = body.toString('utf-8');

  // Parse into a virtual DOM document.
  const { document } = parseHTML(html);

  // Resolve relative URLs against the final (post-redirect) location so links
  // and images point at the page we actually fetched.
  const resolveUrl = (relativeUrl: string) => {
    try {
      return new URL(relativeUrl, finalUrl).href;
    } catch {
      return relativeUrl;
    }
  };

  const images = document.querySelectorAll('img');
  for (const img of images) {
    const src = img.getAttribute('src');
    if (src) {
      img.setAttribute('src', resolveUrl(src));
    }
  }

  const links = document.querySelectorAll('a');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href) {
      link.setAttribute('href', resolveUrl(href));
    }
  }

  // Read before Readability, which rewrites the document in place.
  const declaredLanguage = document.documentElement?.getAttribute('lang') ?? null;

  // Readability extracts the core article text.
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('Could not extract meaningful article content from this webpage.');
  }

  // Convert the clean HTML to Markdown.
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });

  const markdown = turndownService.turndown(article.content);
  if (!markdown.trim()) {
    throw new Error('Extracted content is empty.');
  }

  return {
    title: article.title?.trim() || 'Web Import',
    content: markdown,
    author: normalizeAuthor(article.byline),
    language: normalizeLanguage(article.lang) ?? normalizeLanguage(declaredLanguage),
  };
}
