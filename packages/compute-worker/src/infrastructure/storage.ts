import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolveStorageTransport } from '@openreader/runtime-config/storage-transport';

export interface StoredObjectSummary {
  key: string;
  size: number;
  lastModifiedMs: number;
}

export const PARSED_PDF_NARRATION_REVISION_METADATA = 'narration-revision';

export interface ParsedPdfArtifactRevision {
  etag: string;
  operationId?: string;
}

export interface ParsedPdfArtifactStorage extends ArtifactStorage {
  getParsedPdfRevision(documentId: string, namespace: string | null, signal: AbortSignal): Promise<ParsedPdfArtifactRevision | null>;
}

export interface ArtifactStorage {
  readObject(key: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  getObjectEtag?(key: string, signal?: AbortSignal): Promise<string | null>;
  headObject?(key: string, signal?: AbortSignal): Promise<{ etag: string; metadata: Record<string, string>; size?: number } | null>;
  objectExists(key: string, signal?: AbortSignal): Promise<boolean>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
  listPrefix(prefix: string, signal?: AbortSignal): Promise<string[]>;
  /**
   * Page through a prefix with object sizes, one ListObjectsV2 page at a time,
   * so size aggregation never holds a whole prefix listing in memory.
   */
  listPrefixPages(prefix: string): AsyncIterable<StoredObjectSummary[]>;
  /**
   * Names of the immediate child "folders" of `prefix` (which must end in
   * `/`), in key order, without listing the objects inside them. Pass the last
   * name returned as `startAfter` to continue.
   */
  listChildPrefixes(prefix: string, options?: { startAfter?: string; limit?: number }): Promise<string[]>;
  putObject(key: string, body: Buffer | Uint8Array, contentType?: string, signal?: AbortSignal, expectedEtag?: string | null, metadata?: Record<string, string>): Promise<void>;
  /** Upload a derived file without materializing the entire artifact in memory. */
  putFile(key: string, path: string, contentType: string, signal?: AbortSignal): Promise<void>;
  putParsedPdf(documentId: string, namespace: string | null, parsed: unknown, options: {
    operationId: string;
    expected: ParsedPdfArtifactRevision | null;
    /** Mirrors the layout's `narrationRevision` so callers can read it without the body. */
    narrationRevision?: string;
    signal: AbortSignal;
  }): Promise<string>;
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

export function isNotFound(error: unknown): boolean {
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 404
    || maybe.name === 'NotFound'
    || maybe.name === 'NoSuchKey'
    || maybe.Code === 'NotFound'
    || maybe.Code === 'NoSuchKey';
}

export function isPreconditionFailed(error: unknown): boolean {
  const response = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return response?.$metadata?.httpStatusCode === 412 || response?.name === 'PreconditionFailed';
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

export function createArtifactStorage(config: ArtifactStorageConfig): ParsedPdfArtifactStorage {
  const safeKey = (key: string): string => {
    const trimmed = key.trim();
    if (!trimmed.startsWith(`${config.prefix}/`)) throw new Error('Object key prefix mismatch');
    return trimmed;
  };

  const headObject: NonNullable<ArtifactStorage['headObject']> = async (key, signal) => {
    try {
      const response = await config.client.send(new HeadObjectCommand({
        Bucket: config.bucket, Key: safeKey(key),
      }), { abortSignal: signal });
      if (!response.ETag) throw new Error('Stored object is missing its ETag');
      return { etag: response.ETag, metadata: response.Metadata ?? {}, size: response.ContentLength };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  return {
    headObject,
    async getObjectEtag(key, signal) {
      return (await headObject(key, signal))?.etag ?? null;
    },
    async readObject(key, signal) {
      const response = await config.client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
      }), { abortSignal: signal });
      return toArrayBuffer(new Uint8Array(await bodyToBuffer(response.Body)));
    },
    async objectExists(key, signal) {
      try {
        await config.client.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: safeKey(key),
        }), { abortSignal: signal });
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async deleteObject(key, signal) {
      await config.client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
      }), { abortSignal: signal });
    },
    async listPrefix(prefix, signal) {
      const safePrefix = safeKey(prefix);
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await config.client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: safePrefix,
          ContinuationToken: continuationToken,
        }), { abortSignal: signal });
        for (const item of response.Contents ?? []) {
          if (typeof item.Key === 'string') keys.push(item.Key);
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return keys;
    },
    async *listPrefixPages(prefix) {
      const safePrefix = safeKey(prefix);
      let continuationToken: string | undefined;
      do {
        const response = await config.client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: safePrefix,
          ContinuationToken: continuationToken,
        }));
        const page: StoredObjectSummary[] = [];
        for (const item of response.Contents ?? []) {
          if (typeof item.Key === 'string') {
            page.push({
              key: item.Key,
              size: Math.max(0, Number(item.Size) || 0),
              lastModifiedMs: item.LastModified?.getTime() ?? 0,
            });
          }
        }
        if (page.length > 0) yield page;
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    },
    async listChildPrefixes(prefix, options) {
      const safePrefix = safeKey(prefix);
      if (!safePrefix.endsWith('/')) throw new Error('Child prefix listing requires a trailing slash');
      const limit = options?.limit ?? Number.POSITIVE_INFINITY;
      const names: string[] = [];
      // S3 orders children by their `name/` prefix, and the cursor is the last
      // name in that order. A sibling such as `name-` sorts before `name/`, so
      // it was already returned; '0' is the byte right after '/', so this skips
      // exactly the keys inside the `startAfter` folder.
      const startAfter = options?.startAfter ? `${safePrefix}${options.startAfter}0` : undefined;
      let continuationToken: string | undefined;
      do {
        const response = await config.client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: safePrefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
          StartAfter: continuationToken ? undefined : startAfter,
          MaxKeys: Number.isFinite(limit) ? Math.min(1000, Math.max(1, limit - names.length)) : undefined,
        }));
        for (const common of response.CommonPrefixes ?? []) {
          if (typeof common.Prefix !== 'string') continue;
          names.push(common.Prefix.slice(safePrefix.length, -1));
          if (names.length >= limit) return names;
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return names;
    },
    async putObject(key, body, contentType, signal, expectedEtag, metadata) {
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: safeKey(key),
        Body: Buffer.from(body),
        ContentType: contentType,
        ...(metadata ? { Metadata: metadata } : {}),
        ServerSideEncryption: 'AES256',
        ...(expectedEtag === null ? { IfNoneMatch: '*' } : expectedEtag ? { IfMatch: expectedEtag } : {}),
      }), { abortSignal: signal });
    },
    async putFile(key, path, contentType, signal) {
      const { size } = await stat(path);
      const body = createReadStream(path);
      try {
        await config.client.send(new PutObjectCommand({
          Bucket: config.bucket, Key: safeKey(key), Body: body,
          ContentLength: size, ContentType: contentType, ServerSideEncryption: 'AES256',
        }), { abortSignal: signal });
      } finally {
        body.destroy();
      }
    },
    async getParsedPdfRevision(documentId, namespace, signal) {
      const key = parsedPdfArtifactKey({ documentId, namespace, prefix: config.prefix });
      try {
        const response = await config.client.send(new HeadObjectCommand({
          Bucket: config.bucket, Key: key,
        }), { abortSignal: signal });
        if (!response.ETag) throw new Error('Parsed PDF artifact is missing its ETag');
        return { etag: response.ETag, operationId: response.Metadata?.['operation-id'] };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async putParsedPdf(documentId, namespace, parsed, options) {
      const key = parsedPdfArtifactKey({ documentId, namespace, prefix: config.prefix });
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(JSON.stringify(parsed)),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: {
          'operation-id': options.operationId,
          ...(options.narrationRevision ? { [PARSED_PDF_NARRATION_REVISION_METADATA]: options.narrationRevision } : {}),
        },
        ...(options.expected ? { IfMatch: options.expected.etag } : { IfNoneMatch: '*' }),
      }), { abortSignal: options.signal });
      return key;
    },
  };
}
