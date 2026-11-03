import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { fetchExternal } from '@/lib/server/external-fetch';
import { normalizeAuthor, normalizeLanguage } from '@/lib/server/documents/import-metadata';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;

function fetchPage(urlStr: string) {
  return fetchExternal(urlStr, {
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    acceptsContentType: type => type.includes('text/html') || type.includes('application/xhtml+xml') || type.includes('text/plain'),
    messages: {
      status: status => `Failed to fetch webpage (status ${status})`,
      contentType: 'Unsupported content type. Only web pages or text files are supported.',
      tooLarge: 'Web page size exceeds the maximum allowed limit of 2MB.',
      tooManyRedirects: 'Too many redirects while fetching the webpage.',
    },
  });
}

/**
 * Connects to, extracts readable content from, and converts a web page to Markdown.
 */
export async function fetchAndParseUrl(
  urlStr: string
): Promise<{ title: string; content: string; author: string | null; language: string | null }> {
  // 1. Fetch HTML content with limit. The AntiSSRF agent validates the
  //    destination (and every redirect hop) at connection time.
  const { body, finalUrl } = await fetchPage(urlStr);
  const html = body.toString('utf-8');

  // 2. Parse HTML string to a virtual DOM document
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

  // 3. Run Readability to extract core article text
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('Could not extract meaningful article content from this webpage.');
  }

  // 4. Convert clean HTML content to Markdown
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
