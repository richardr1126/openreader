#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const LEGACY_PREFIXES = [
  'tts_segments_v1/',
  'tts_segments_v2/',
  'audiobooks_v1/',
];

function findWorkspaceRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return startDir;
}

function loadEnvFiles() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const envPath = path.join(workspaceRoot, '.env');
  const envLocalPath = path.join(workspaceRoot, '.env.local');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
  }
}

function parseBool(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePrefix(prefix) {
  const base = String(prefix || 'openreader').trim();
  if (!base) return 'openreader';
  return base.replace(/^\/+|\/+$/g, '');
}

export function hasV4DecommissionS3Config(env = process.env) {
  return Boolean(
    env.S3_BUCKET?.trim()
    && env.S3_REGION?.trim()
    && env.S3_ACCESS_KEY_ID?.trim()
    && env.S3_SECRET_ACCESS_KEY?.trim()
  );
}

function parseS3ConfigFromEnv(env) {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = env.S3_ENDPOINT?.trim();

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 is not configured. Required env vars: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
  }

  return {
    bucket,
    region,
    endpoint: endpoint || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBool(env.S3_FORCE_PATH_STYLE, false),
    prefix: normalizePrefix(env.S3_PREFIX),
  };
}

function createS3Client(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

async function purgePrefix(s3Client, s3Config, relativePrefix) {
  const prefix = `${s3Config.prefix}/${relativePrefix}`;
  let continuationToken;
  let deletedObjects = 0;
  let listRequests = 0;
  let deleteRequests = 0;

  do {
    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: s3Config.bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    listRequests += 1;

    const objects = (listed.Contents ?? [])
      .map((object) => object.Key)
      .filter((key) => typeof key === 'string' && key.length > 0)
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      const deleted = await s3Client.send(new DeleteObjectsCommand({
        Bucket: s3Config.bucket,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      }));
      const errors = deleted.Errors ?? [];
      if (errors.length > 0) {
        throw new Error(`Failed deleting ${errors.length} object(s) under ${prefix}`);
      }
      deletedObjects += objects.length;
      deleteRequests += 1;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return {
    prefix,
    deletedObjects,
    listRequests,
    deleteRequests,
  };
}

export async function runV4Decommission(env = process.env) {
  const s3Config = parseS3ConfigFromEnv(env);
  const s3Client = createS3Client(s3Config);
  const prefixes = [];

  console.log('Running v4 legacy storage decommission...');
  for (const relativePrefix of LEGACY_PREFIXES) {
    const result = await purgePrefix(s3Client, s3Config, relativePrefix);
    prefixes.push(result);
    console.log(`Purged ${result.deletedObjects} object(s) under ${result.prefix}`);
  }

  const deletedObjects = prefixes.reduce((sum, result) => sum + result.deletedObjects, 0);
  console.log(`v4 legacy storage decommission complete: ${deletedObjects} object(s) deleted.`);

  return {
    deletedObjects,
    prefixes,
  };
}

async function main() {
  loadEnvFiles();
  if (!hasV4DecommissionS3Config(process.env)) {
    throw new Error('S3 configuration is incomplete; cannot run v4 legacy storage decommission.');
  }
  await runV4Decommission(process.env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
