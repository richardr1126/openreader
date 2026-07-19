import { S3Client } from '@aws-sdk/client-s3';
import { resolveStorageTransport } from '@openreader/runtime-config/storage-transport';
import { serverLogger } from '@/lib/server/logger';

type S3Config = {
  bucket: string;
  region: string;
  internalEndpoint: string;
  publicEndpoint?: string;
  browserTransport: 'proxy' | 'presigned';
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
};

let cachedPublicClient: S3Client | null = null;
let cachedInternalClient: S3Client | null = null;
let cachedConfig: S3Config | null = null;
let warnedDeprecatedEndpoint = false;

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

function loadS3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const transport = resolveStorageTransport(process.env);
  if (transport.usesDeprecatedEndpoint && !warnedDeprecatedEndpoint) {
    warnedDeprecatedEndpoint = true;
    serverLogger.warn(
      { event: 'storage.s3_endpoint_deprecated' },
      'S3_ENDPOINT is deprecated; configure S3_INTERNAL_ENDPOINT and S3_PUBLIC_ENDPOINT. S3_ENDPOINT will be removed in OpenReader 5.0.',
    );
  }

  return {
    bucket,
    region,
    internalEndpoint: transport.internalEndpoint,
    publicEndpoint: transport.publicEndpoint,
    browserTransport: transport.mode as 'proxy' | 'presigned',
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
  return getS3PublicClient();
}

export function getS3PublicClient(): S3Client {
  if (cachedPublicClient) return cachedPublicClient;
  const config = getS3Config();
  if (!config.publicEndpoint) {
    throw new Error('Direct browser object transfer is disabled because S3_BROWSER_TRANSPORT=proxy.');
  }

  cachedPublicClient = new S3Client({
    region: config.region,
    endpoint: config.publicEndpoint,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return cachedPublicClient;
}

export function getS3InternalClient(): S3Client {
  const config = getS3Config();
  if (cachedInternalClient) return cachedInternalClient;
  cachedInternalClient = new S3Client({
    region: config.region,
    endpoint: config.internalEndpoint,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return cachedInternalClient;
}

/** @deprecated Use getS3InternalClient. */
export function getS3ProxyClient(): S3Client {
  return getS3InternalClient();
}

export function getBrowserStorageTransport(): 'proxy' | 'presigned' {
  return getS3Config().browserTransport;
}
