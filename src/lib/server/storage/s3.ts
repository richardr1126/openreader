import { S3Client } from '@aws-sdk/client-s3';

type S3Config = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
};

let cachedClient: S3Client | null = null;
let cachedLoopbackClient: S3Client | null = null;
let cachedConfig: S3Config | null = null;

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizePrefix(prefix: string | undefined): string {
  const base = (prefix || 'openreader').trim();
  if (!base) return 'openreader';
  return base.replace(/^\/+|\/+$/g, '');
}

function isEmbeddedWeedMiniEnabled(): boolean {
  const raw = process.env.USE_EMBEDDED_WEED_MINI;
  if (raw == null || raw.trim() === '') return true;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function loopbackEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return endpoint;
  try {
    const parsed = new URL(endpoint);
    parsed.hostname = '127.0.0.1';
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return endpoint;
  }
}

/**
 * Returns true when the configured S3 endpoint is a loopback/localhost address.
 *
 * Presigned direct-to-storage URLs are signed against S3_ENDPOINT and handed to
 * the browser. When S3_ENDPOINT is a loopback address they only resolve if the
 * browser runs on the same host as the server. The recommended embedded
 * SeaweedFS deployment behind a reverse proxy sets `S3_ENDPOINT=http://127.0.0.1:8333`
 * (the internal proxy client also rewrites to loopback), so those presigned URLs
 * are unreachable from a remote browser. In that case callers should serve blobs
 * through the same-origin `/api/.../fallback` proxy routes instead of presigning.
 */
export function isLoopbackS3Endpoint(): boolean {
  const config = loadS3ConfigFromEnv();
  if (!config?.endpoint) return false;
  try {
    const host = new URL(config.endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

function loadS3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim();

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    bucket,
    region,
    endpoint: endpoint || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBool(process.env.S3_FORCE_PATH_STYLE),
    prefix: normalizePrefix(process.env.S3_PREFIX),
  };
}

export function isS3Configured(): boolean {
  return loadS3ConfigFromEnv() !== null;
}

export function getS3Config(): S3Config {
  if (cachedConfig) return cachedConfig;
  const config = loadS3ConfigFromEnv();
  if (!config) {
    throw new Error(
      'S3 is not configured. Required env vars: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.',
    );
  }
  cachedConfig = config;
  return config;
}

export function getS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  const config = getS3Config();

  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return cachedClient;
}

export function getS3ProxyClient(): S3Client {
  const config = getS3Config();
  const useLoopback = isEmbeddedWeedMiniEnabled();
  if (!useLoopback) {
    return getS3Client();
  }

  if (cachedLoopbackClient) return cachedLoopbackClient;
  cachedLoopbackClient = new S3Client({
    region: config.region,
    endpoint: loopbackEndpoint(config.endpoint),
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return cachedLoopbackClient;
}
