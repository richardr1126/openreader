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
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return cachedClient;
}

