import dns from 'dns';
import http from 'http';
import https from 'https';
import { promisify } from 'util';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const dnsLookup = promisify(dns.lookup);

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Checks if an IPv4 address falls in a private, loopback, link-local, multicast,
 * or broadcast range. Anything that is not a clean dotted-quad is treated as
 * unsafe (fail closed).
 */
function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return true; // malformed → unsafe
  const [o1, o2] = octets;
  if (o1 === 0) return true; // 0.0.0.0/8 ("this host")
  if (o1 === 10) return true; // 10.0.0.0/8
  if (o1 === 127) return true; // 127.0.0.0/8 loopback
  if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 link-local
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
  if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
  if (o1 >= 224 && o1 <= 239) return true; // 224.0.0.0/4 multicast
  if (ip === '255.255.255.255') return true; // limited broadcast
  return false;
}

/**
 * Checks if an IP address (v4 or v6) is a private, loopback, link-local,
 * multicast, or otherwise non-routable address (SSRF mitigation).
 */
function isPrivateIp(ip: string): boolean {
  let addr = ip.trim().toLowerCase();
  // Strip IPv6 brackets and zone id (e.g. [fe80::1%eth0]).
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  // Plain IPv4.
  if (!addr.includes(':')) return isPrivateIpv4(addr);

  // IPv6 from here.
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified

  // IPv4-mapped (::ffff:a.b.c.d) / -compatible (::a.b.c.d) IPv6: evaluate the
  // embedded IPv4 against the v4 ranges. Any address in the mapped range we
  // cannot cleanly read as a dotted-quad (e.g. the hex form ::ffff:7f00:1) is
  // blocked outright — fail closed. (cf. CVE-2026-47684)
  if (addr.startsWith('::ffff:') || /^::\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const m = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    return m ? isPrivateIpv4(m[1]) : true;
  }

  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^fec/.test(addr)) return true; // fec0::/10 (deprecated site-local)
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (/^ff/.test(addr)) return true; // ff00::/8 multicast
  return false;
}

interface ValidatedTarget {
  url: URL;
  /** The DNS-resolved IP address the connection is pinned to. */
  address: string;
}

/**
 * Resolves the URL domain and validates that it does not point to a local/private
 * network. Returns the parsed URL together with the resolved IP address so the
 * caller can pin the connection to it, closing the DNS-rebinding window between
 * validation and connect.
 */
async function validateUrlForSsrf(urlString: string): Promise<ValidatedTarget> {
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

  let results: { address: string; family: number }[];
  try {
    results = await dnsLookup(hostname, { all: true });
  } catch {
    // Fail closed: do not silently continue and let a later re-resolution decide.
    throw new Error('Could not resolve host address');
  }

  if (results.length === 0) {
    throw new Error('Could not resolve host address');
  }

  // Validate every resolved address; reject if any maps to a private network.
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw new Error('Access to private network address is forbidden');
    }
  }

  return { url, address: results[0].address };
}

/**
 * Performs a single GET request pinned to the already-validated IP address.
 * Resolves with either the response body or a redirect location to follow.
 */
function requestPinned(
  target: ValidatedTarget,
  maxBytes: number,
  timeoutMs: number
): Promise<{ body?: string; redirectLocation?: string }> {
  const { url, address } = target;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const options: https.RequestOptions = {
    host: address, // connect to the validated IP, not a freshly-resolved one
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: {
      // Preserve virtual hosting (host:port) so the origin serves the right vhost.
      Host: url.host,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: timeoutMs,
  };
  if (isHttps) {
    // Validate the TLS certificate against the original hostname, not the IP.
    options.servername = url.hostname;
  }

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
 * timeout (default 6s). Each redirect hop is independently re-validated and
 * pinned to its resolved IP to prevent SSRF via redirects or DNS rebinding.
 */
async function fetchWithLimit(
  urlStr: string,
  maxBytes: number = MAX_BYTES,
  timeoutMs: number = TIMEOUT_MS
): Promise<string> {
  let currentUrl = urlStr;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const target = await validateUrlForSsrf(currentUrl);
    const result = await requestPinned(target, maxBytes, timeoutMs);

    if (result.redirectLocation) {
      currentUrl = new URL(result.redirectLocation, target.url).href;
      continue;
    }

    return result.body ?? '';
  }

  throw new Error('Too many redirects while fetching the webpage.');
}

/**
 * Connects to, extracts readable content from, and converts a web page to Markdown.
 */
export async function fetchAndParseUrl(
  urlStr: string
): Promise<{ title: string; content: string }> {
  // 1. Fetch HTML content with limit (SSRF validation + IP pinning happens
  //    inside fetchWithLimit for the initial URL and every redirect hop).
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
