import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { resolveStorageTransport } from '../../../bootstrap/src/storage-transport.mjs';

export interface ArtifactStorage {
  readObject(key: string): Promise<ArrayBuffer>;
  objectExists(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  listPrefix(prefix: string): Promise<string[]>;
  putObject(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<void>;
  putParsedPdf(documentId: string, namespace: string | null, parsed: unknown): Promise<string>;
}

export interface ArtifactStorageConfig {
  bucket: string;
  prefix: string;
  client: S3Client;
}

function bodyToBuffer(body: unknown): Promise<Buffer> | Buffer {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof maybe.transformToByteArray === 'function') {
      return maybe.transformToByteArray().then((bytes) => Buffer.from(bytes));
    }
  }
  if (typeof body === 'object' && body !== null && 'on' in body) {
    return (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of body as NodeJS.ReadableStream) {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    })();
  }
  throw new Error('Unsupported S3 response body type');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isNotFound(error: unknown): boolean {
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 404
    || maybe.name === 'NotFound'
    || maybe.name === 'NoSuchKey'
    || maybe.Code === 'NotFound'
    || maybe.Code === 'NoSuchKey';
}

export function normalizeS3Prefix(prefix: string | undefined): string {
  const value = (prefix || 'openreader').trim();
  return value ? value.replace(/^\/+|\/+$/g, '') : 'openreader';
}

export function createS3ClientFromEnv(requireEnv: (name: string) => string): S3Client {
  const transport = resolveStorageTransport(process.env);
  return new S3Client({
    region: requireEnv('S3_REGION'),
    endpoint: transport.internalEndpoint,
    forcePathStyle: ['1', 'true', 'yes', 'on'].includes(process.env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() ?? ''),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    },
  });
}

export function createArtifactStorage(config: ArtifactStorageConfig): ArtifactStorage {
  const safeKey = (key: string): string => {
    const trimmed = key.trim();
    if (!trimmed.startsWith(`${config.prefix}/`)) throw new Error('Object key prefix mismatch');
    return trimmed;
  };

  return {
    async readObject(key) {
      const response = await config.client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
      }));
      return toArrayBuffer(new Uint8Array(await bodyToBuffer(response.Body)));
    },
    async objectExists(key) {
      try {
        await config.client.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: safeKey(key),
        }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async deleteObject(key) {
      await config.client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
      }));
    },
    async listPrefix(prefix) {
      const safePrefix = safeKey(prefix);
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await config.client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: safePrefix,
          ContinuationToken: continuationToken,
        }));
        for (const item of response.Contents ?? []) {
          if (typeof item.Key === 'string') keys.push(item.Key);
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return keys;
    },
    async putObject(key, body, contentType) {
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
        Body: Buffer.from(body),
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }));
    },
    async putParsedPdf(documentId, namespace, parsed) {
      const key = parsedPdfArtifactKey({ documentId, namespace, prefix: config.prefix });
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(JSON.stringify(parsed)),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }));
      return key;
    },
  };
}
