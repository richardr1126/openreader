import http from 'http';
import https from 'https';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { AntiSSRFPolicy, PolicyConfigOptions } from '@microsoft/antissrf';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * SSRF protection is delegated to Microsoft's AntiSSRF library. The policy's
 * agents inject a connection-time DNS lookup that resolves the host and rejects
 * any request whose resolved address falls in an internal/special-purpose range
 * (loopback, private, link-local, CGNAT, cloud metadata, multicast, …). Because
 * the check happens on the address the socket actually connects to, it is
 * inherently safe against DNS rebinding, and it re-runs on every redirect hop
 * (each hop is a fresh request through the agent).
 *
 * `ExternalOnlyLatest` blocks the `recommendedLatest` range set and stays
 * up to date without code changes. We allow plain HTTP because article URLs are
 * not always HTTPS; remove `allowPlainTextHttp` to require HTTPS.
 */
const ssrfPolicy = new AntiSSRFPolicy(PolicyConfigOptions.ExternalOnlyLatest);
ssrfPolicy.allowPlainTextHttp = true;
const httpAgent = ssrfPolicy.getHttpAgent();
const httpsAgent = ssrfPolicy.getHttpsAgent();

/**
 * Performs a single GET request through the AntiSSRF agent. Resolves with either
 * the response body or a redirect location to follow. Enforces a size limit and
 * a hard timeout (resource limits, independent of the SSRF policy).
 */
function requestOnce(
  url: URL,
  maxBytes: number,
  timeoutMs: number
): Promise<{ body?: string; redirectLocation?: string }> {
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const options: https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname, // connect by hostname so the agent's safe lookup runs
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    agent, // AntiSSRF agent enforces the SSRF policy at connection time
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (v: { body?: string; redirectLocation?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(v);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(e);
    };

    const req = lib.request(options, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain so the socket can be reused/closed
        ok({ redirectLocation: res.headers.location });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        fail(new Error(`Failed to fetch webpage (status ${status})`));
        return;
      }

      const contentType = (res.headers['content-type'] || '').toString();
      const isHtml =
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml+xml');
      const isText = contentType.includes('text/plain');
      if (!isHtml && !isText) {
        res.resume();
        fail(
          new Error('Unsupported content type. Only web pages or text files are supported.')
        );
        return;
      }

      const contentLength = res.headers['content-length'];
      if (contentLength && parseInt(contentLength.toString(), 10) > maxBytes) {
        res.resume();
        fail(new Error('Web page size exceeds the maximum allowed limit of 2MB.'));
        return;
      }

      // Stream and enforce the size limit dynamically (header may be absent/spoofed).
      let received = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy();
          fail(new Error('Web page size exceeds the maximum allowed limit of 2MB.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => ok({ body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', fail);
    });

    // Hard deadline covering the whole request (connect + transfer), in addition
    // to the socket idle timeout, to bound slow-read/slowloris responses.
    const hardTimer = setTimeout(() => {
      req.destroy(new Error('Request timed out'));
    }, timeoutMs);

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', fail);
    req.end();
  });
}

/**
 * Validates and fetches a URL with a size limit (default 2MB) and connection
 * timeout (default 6s). Redirects are followed manually so each hop is re-checked
 * by the AntiSSRF agent and counted against the redirect cap. Returns the body
 * and the final (post-redirect) URL.
 */
async function fetchWithLimit(
  urlStr: string,
  maxBytes: number = MAX_BYTES,
  timeoutMs: number = TIMEOUT_MS
): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = urlStr;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      throw new Error('Invalid URL format');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS protocols are supported');
    }

    const result = await requestOnce(url, maxBytes, timeoutMs);

    if (result.redirectLocation) {
      currentUrl = new URL(result.redirectLocation, url).href;
      continue;
    }

    return { html: result.body ?? '', finalUrl: currentUrl };
  }

  throw new Error('Too many redirects while fetching the webpage.');
}

/**
 * Connects to, extracts readable content from, and converts a web page to Markdown.
 */
export async function fetchAndParseUrl(
  urlStr: string
): Promise<{ title: string; content: string }> {
  // 1. Fetch HTML content with limit. The AntiSSRF agent validates the
  //    destination (and every redirect hop) at connection time.
  const { html, finalUrl } = await fetchWithLimit(urlStr);

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
  };
}
