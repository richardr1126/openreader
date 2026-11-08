import http from 'http';
import https from 'https';
import { AntiSSRFPolicy, PolicyConfigOptions } from '@microsoft/antissrf';

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
 * up to date without code changes. Plain HTTP stays allowed because article URLs
 * are not always HTTPS; a caller that requires HTTPS says so through `allowsUrl`.
 */
const ssrfPolicy = new AntiSSRFPolicy(PolicyConfigOptions.ExternalOnlyLatest);
ssrfPolicy.allowPlainTextHttp = true;
const httpAgent = ssrfPolicy.getHttpAgent();
const httpsAgent = ssrfPolicy.getHttpsAgent();

export type ExternalFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  accept: string;
  acceptsContentType: (contentType: string) => boolean;
  /** Checked on the first URL and every redirect hop. */
  allowsUrl?: (url: URL) => boolean;
  messages: { status: (status: number) => string; contentType: string; tooLarge: string; tooManyRedirects: string };
};

/**
 * Performs a single GET request through the AntiSSRF agent. Resolves with either
 * the response body or a redirect location to follow. Enforces a size limit and
 * a hard timeout (resource limits, independent of the SSRF policy).
 */
function requestOnce(url: URL, options: ExternalFetchOptions, deadline: number): Promise<{ body?: Buffer; redirectLocation?: string }> {
  const { maxBytes, messages } = options;
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return Promise.reject(new Error('Request timed out'));
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const requestOptions: https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname, // connect by hostname so the agent's safe lookup runs
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    agent, // AntiSSRF agent enforces the SSRF policy at connection time
    headers: {
      'User-Agent': USER_AGENT,
      Accept: options.accept,
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (v: { body?: Buffer; redirectLocation?: string }) => {
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

    const req = lib.request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain so the socket can be reused/closed
        ok({ redirectLocation: res.headers.location });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        fail(new Error(messages.status(status)));
        return;
      }

      if (!options.acceptsContentType((res.headers['content-type'] || '').toString())) {
        res.resume();
        fail(new Error(messages.contentType));
        return;
      }

      const contentLength = res.headers['content-length'];
      if (contentLength && parseInt(contentLength.toString(), 10) > maxBytes) {
        res.resume();
        fail(new Error(messages.tooLarge));
        return;
      }

      // Stream and enforce the size limit dynamically (header may be absent/spoofed).
      let received = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy();
          fail(new Error(messages.tooLarge));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => ok({ body: Buffer.concat(chunks) }));
      res.on('error', fail);
    });

    // Hard deadline shared by every redirect hop (connect + transfer), in addition
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
 * Fetches an untrusted URL within the given limits. Redirects are followed
 * manually so each hop is re-checked by the AntiSSRF agent and `allowsUrl`, and
 * counted against the redirect cap. Returns the body and the final URL.
 */
export async function fetchExternal(urlStr: string, options: ExternalFetchOptions): Promise<{ body: Buffer; finalUrl: string }> {
  let currentUrl = urlStr;
  const deadline = Date.now() + options.timeoutMs;

  for (let redirects = 0; redirects <= options.maxRedirects; redirects++) {
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      throw new Error('Invalid URL format');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS protocols are supported');
    }
    if (options.allowsUrl && !options.allowsUrl(url)) throw new Error('That URL is not allowed');

    const result = await requestOnce(url, options, deadline);

    if (result.redirectLocation) {
      currentUrl = new URL(result.redirectLocation, url).href;
      continue;
    }

    return { body: result.body ?? Buffer.alloc(0), finalUrl: currentUrl };
  }

  throw new Error(options.messages.tooManyRedirects);
}
