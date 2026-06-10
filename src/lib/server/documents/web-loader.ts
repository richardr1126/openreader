import dns from 'dns';
import { promisify } from 'util';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const dnsLookup = promisify(dns.lookup);

/**
 * Checks if an IP address is a private, loopback, or link-local address (SSRF mitigation).
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 checks
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;

  const ipv4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, o1, o2] = ipv4Match.map(Number);
    if (o1 === 10) return true; // 10.0.0.0/8
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16
  }

  // IPv6 checks
  const ipLower = ip.toLowerCase();
  if (
    ipLower === '::1' ||
    ipLower === '::' ||
    ipLower === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }
  if (
    ipLower.startsWith('fe80:') ||
    ipLower.startsWith('fc00:') ||
    ipLower.startsWith('fd00:')
  ) {
    return true;
  }

  return false;
}

/**
 * Resolves the URL domain and validates that it does not point to a local/private network.
 */
async function validateUrlForSsrf(urlString: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are supported');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === 'localhost') {
    throw new Error('Access to localhost is forbidden');
  }

  try {
    const lookupResult = await dnsLookup(hostname);
    if (isPrivateIp(lookupResult.address)) {
      throw new Error(`Access to private network address is forbidden`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('forbidden')) {
      throw err;
    }
    // If lookup fails entirely, let the fetch attempt fail or resolve naturally
  }

  return urlString;
}

/**
 * Fetches a URL with a size limit (default 2MB) and connection timeout (default 6s).
 */
async function fetchWithLimit(
  urlStr: string,
  maxBytes: number = 2 * 1024 * 1024,
  timeoutMs: number = 6000
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch webpage (status ${res.status})`);
    }

    const contentType = res.headers.get('content-type') || '';
    const isHtml =
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml+xml');
    const isText = contentType.includes('text/plain');

    if (!isHtml && !isText) {
      throw new Error('Unsupported content type. Only web pages or text files are supported.');
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new Error('Web page size exceeds the maximum allowed limit of 2MB.');
    }

    // Read response body chunks to verify size limit dynamically in case Content-Length header is missing/spoofed
    const reader = res.body?.getReader();
    if (!reader) {
      // Fallback for environments lacking full stream reader support
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new Error('Web page size exceeds the maximum allowed limit of 2MB.');
      }
      return text;
    }

    let bytesReceived = 0;
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        bytesReceived += value.length;
        if (bytesReceived > maxBytes) {
          controller.abort();
          throw new Error('Web page size exceeds the maximum allowed limit of 2MB.');
        }
        chunks.push(value);
      }
    }

    const merged = new Uint8Array(bytesReceived);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(merged);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Connects to, extracts readable content from, and converts a web page to Markdown.
 */
export async function fetchAndParseUrl(
  urlStr: string
): Promise<{ title: string; content: string }> {
  // 1. SSRF prevention check
  await validateUrlForSsrf(urlStr);

  // 2. Fetch HTML content with limit
  const html = await fetchWithLimit(urlStr);

  // 3. Parse HTML string to a virtual DOM document
  const { document } = parseHTML(html);

  // Resolve relative URLs for links and images to absolute paths based on source URL base
  const resolveUrl = (relativeUrl: string) => {
    try {
      return new URL(relativeUrl, urlStr).href;
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

  // 4. Run Readability to extract core article text
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('Could not extract meaningful article content from this webpage.');
  }

  // 5. Convert clean HTML content to Markdown
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
  };
}
