export type SystemCheckStatus = 'ok' | 'warn' | 'error';

export interface SystemCheckItem {
  id: string;
  label: string;
  status: SystemCheckStatus;
  detail: string;
  fix?: string;
}

/**
 * Server-side results plus the two addresses only the admin's browser can judge:
 * whether it can reach the worker's public audio URL and whether it opened the app
 * at BASE_URL.
 */
export interface SystemCheckReport {
  checks: SystemCheckItem[];
  baseUrl: string | null;
  workerPublicUrl: string | null;
}

export type WorkerProbeResult = 'reachable' | 'unreachable';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True when the browser would block loading `target` from a page at `page` as mixed content. */
export function isBlockedMixedContent(page: URL, target: URL): boolean {
  return page.protocol === 'https:' && target.protocol === 'http:' && !isLoopbackHost(target.hostname);
}

export function evaluateBrowserChecks(input: {
  pageOrigin: string;
  baseUrl: string | null;
  workerPublicUrl: string | null;
  workerProbe: WorkerProbeResult | null;
}): SystemCheckItem[] {
  const items: SystemCheckItem[] = [];
  const page = parseUrl(input.pageOrigin);
  const base = parseUrl(input.baseUrl);
  const worker = parseUrl(input.workerPublicUrl);

  if (page && base) {
    const matches = page.origin === base.origin;
    items.push({
      id: 'base-url',
      label: 'Address you opened',
      status: matches ? 'ok' : 'warn',
      detail: matches
        ? `Matches BASE_URL (${base.origin}).`
        : `You opened ${page.origin}, but BASE_URL is ${base.origin}. Sign-in cookies and trusted origins follow BASE_URL, so other addresses can fail to sign in.`,
      fix: matches ? undefined : 'Open OpenReader at BASE_URL, or change BASE_URL to the address people use. List extra addresses in AUTH_TRUSTED_ORIGINS.',
    });
  }

  if (page && worker) {
    if (isBlockedMixedContent(page, worker)) {
      items.push({
        id: 'worker-public-url',
        label: 'Playback audio URL (this browser)',
        status: 'error',
        detail: `This page is https but playback audio loads from ${worker.origin} over http, which browsers block as mixed content.`,
        fix: 'Serve the worker over https and set COMPUTE_WORKER_PUBLIC_URL to that address.',
      });
    } else if (input.workerProbe === 'reachable') {
      items.push({
        id: 'worker-public-url',
        label: 'Playback audio URL (this browser)',
        status: 'ok',
        detail: `This browser can reach ${worker.origin}.`,
      });
    } else if (input.workerProbe === 'unreachable') {
      items.push({
        id: 'worker-public-url',
        label: 'Playback audio URL (this browser)',
        status: 'error',
        detail: `This browser cannot reach ${worker.origin}, so playback audio will not load.`,
        fix: 'Publish worker port 8081 and set COMPUTE_WORKER_PUBLIC_URL to an address this browser can reach, for example http://<host>:8081. In a container, also make sure the worker listens on all interfaces (COMPUTE_WORKER_HOST=0.0.0.0).',
      });
    }
  }

  return items;
}
