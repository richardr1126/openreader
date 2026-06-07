import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PDF_PARSER_VERSION, encodeParserVersion } from '@openreader/compute-core/api-contracts';
import { getS3Client, getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const TEMP_UPLOAD_TOKEN_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMP_UPLOAD_USER_ID_REGEX = /^[a-zA-Z0-9._:-]{1,256}$/;
export const TEMP_DOCUMENT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function sanitizeNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  if (!SAFE_NAMESPACE_REGEX.test(namespace)) return null;
  return namespace;
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return !!value && typeof value === 'object' && 'on' in value && typeof (value as NodeJS.ReadableStream).on === 'function';
}

export type DocumentBlobBody =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | { transformToByteArray: () => Promise<Uint8Array> };

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  }
  return Buffer.concat(chunks);
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  if (body instanceof Uint8Array) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);

  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof maybe.transformToByteArray === 'function') {
      return Buffer.from(await maybe.transformToByteArray());
    }
  }

  if (isNodeReadableStream(body)) {
    return streamToBuffer(body);
  }

  throw new Error('Unsupported S3 response body type');
}

export function isValidDocumentId(id: string): boolean {
  return DOCUMENT_ID_REGEX.test(id);
}

export function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 412 || maybe.name === 'PreconditionFailed';
}

export function isValidTempUploadToken(token: string): boolean {
  return TEMP_UPLOAD_TOKEN_REGEX.test(token);
}

function sanitizeTempUploadUserId(userId: string): string {
  if (!TEMP_UPLOAD_USER_ID_REGEX.test(userId)) {
    throw new Error(`Invalid temp upload user id: ${userId}`);
  }
  return encodeURIComponent(userId);
}

export function documentKey(id: string, namespace: string | null): string {
  if (!isValidDocumentId(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }

  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/documents_v1/${nsSegment}${id}`;
}

export function documentParsedKey(id: string, namespace: string | null): string {
  return documentParsedKeyForVersion(id, namespace, PDF_PARSER_VERSION);
}

export function documentParsedKeyForVersion(
  id: string,
  namespace: string | null,
  parserVersion: string,
): string {
  if (!isValidDocumentId(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }
  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/documents_v1/parsed_v2/${nsSegment}${id}/${encodeParserVersion(parserVersion)}.json`;
}

export function tempDocumentUploadPrefix(userId: string, namespace: string | null): string {
  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/document_uploads_temp_v1/${nsSegment}users/${sanitizeTempUploadUserId(userId)}/`;
}

export function tempDocumentUploadKey(token: string, userId: string, namespace: string | null): string {
  if (!isValidTempUploadToken(token)) {
    throw new Error(`Invalid temp upload token: ${token}`);
  }
  return `${tempDocumentUploadPrefix(userId, namespace)}${token}.bin`;
}

export function tempDocumentUploadReceiptKey(token: string, userId: string, namespace: string | null): string {
  if (!isValidTempUploadToken(token)) {
    throw new Error(`Invalid temp upload token: ${token}`);
  }
  return `${tempDocumentUploadPrefix(userId, namespace)}${token}.receipt.json`;
}

function legacyDocumentParsedKey(id: string, namespace: string | null): string {
  if (!isValidDocumentId(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }
  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/documents_v1/${nsSegment}${id}/parsed.v1.json`;
}

export async function presignPut(
  id: string,
  contentType: string,
  namespace: string | null,
  options?: { contentLength?: number },
): Promise<{ url: string; headers: Record<string, string> }> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = documentKey(id, namespace);
  const normalizedType = (contentType || 'application/octet-stream').trim() || 'application/octet-stream';

  // When the client declares an exact size, sign Content-Length so S3 rejects a
  // PUT whose body does not match (the browser always sends an accurate
  // Content-Length for a known body). Skipped when size is unknown/zero so the
  // upload still works against stores that enforce the signed header.
  const contentLength =
    typeof options?.contentLength === 'number' && Number.isFinite(options.contentLength) && options.contentLength > 0
      ? Math.floor(options.contentLength)
      : undefined;

  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: normalizedType,
    ServerSideEncryption: 'AES256',
    ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
  });
  const url = await getSignedUrl(client, command, { expiresIn: 60 * 5 });

  return {
    url,
    headers: {
      'Content-Type': normalizedType,
      'x-amz-server-side-encryption': 'AES256',
    },
  };
}

export async function presignTempPut(
  token: string,
  userId: string,
  contentType: string,
  namespace: string | null,
  options?: { contentLength?: number },
): Promise<{ url: string; headers: Record<string, string> }> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = tempDocumentUploadKey(token, userId, namespace);
  const normalizedType = (contentType || 'application/octet-stream').trim() || 'application/octet-stream';
  const contentLength =
    typeof options?.contentLength === 'number' && Number.isFinite(options.contentLength) && options.contentLength > 0
      ? Math.floor(options.contentLength)
      : undefined;

  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: normalizedType,
    ServerSideEncryption: 'AES256',
    ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
  });
  const url = await getSignedUrl(client, command, { expiresIn: 60 * 5 });

  return {
    url,
    headers: {
      'Content-Type': normalizedType,
      'x-amz-server-side-encryption': 'AES256',
    },
  };
}

export async function headDocumentBlob(
  id: string,
  namespace: string | null,
): Promise<{ contentLength: number; contentType: string | null; eTag: string | null }> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return {
    contentLength: Number(res.ContentLength ?? 0),
    contentType: res.ContentType ?? null,
    eTag: res.ETag ?? null,
  };
}

export async function headTempDocumentBlob(
  token: string,
  userId: string,
  namespace: string | null,
): Promise<{ contentLength: number; contentType: string | null; eTag: string | null; lastModified: number | null }> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = tempDocumentUploadKey(token, userId, namespace);
  const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return {
    contentLength: Number(res.ContentLength ?? 0),
    contentType: res.ContentType ?? null,
    eTag: res.ETag ?? null,
    lastModified: res.LastModified?.getTime() ?? null,
  };
}

export async function getDocumentRange(
  id: string,
  start: number,
  endInclusive: number,
  namespace: string | null,
): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Range: `bytes=${Math.max(0, start)}-${Math.max(0, endInclusive)}`,
    }),
  );
  return bodyToBuffer(res.Body);
}

export async function getDocumentBlob(id: string, namespace: string | null): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );
  return bodyToBuffer(res.Body);
}

export async function getTempDocumentBlob(
  token: string,
  userId: string,
  namespace: string | null,
): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = tempDocumentUploadKey(token, userId, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );
  return bodyToBuffer(res.Body);
}

export async function getDocumentBlobStream(id: string, namespace: string | null): Promise<DocumentBlobBody> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );
  return res.Body as DocumentBlobBody;
}

export async function getTempDocumentFinalizeReceipt<T>(
  token: string,
  userId: string,
  namespace: string | null,
): Promise<T | null> {
  try {
    const cfg = getS3Config();
    const client = getS3ProxyClient();
    const key = tempDocumentUploadReceiptKey(token, userId, namespace);
    const res = await client.send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      }),
    );
    const body = await bodyToBuffer(res.Body);
    return JSON.parse(body.toString('utf8')) as T;
  } catch (error) {
    if (isMissingBlobError(error)) return null;
    throw error;
  }
}

export async function getParsedDocumentBlob(id: string, namespace: string | null): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentParsedKey(id, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );
  return bodyToBuffer(res.Body);
}

export async function getParsedDocumentBlobByKey(key: string): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Parsed document key is empty');
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: trimmed,
    }),
  );
  return bodyToBuffer(res.Body);
}

export async function putParsedDocumentBlob(id: string, body: Buffer, namespace: string | null): Promise<string> {
  return putParsedDocumentBlobForVersion(id, body, namespace, PDF_PARSER_VERSION);
}

export async function putParsedDocumentBlobForVersion(
  id: string,
  body: Buffer,
  namespace: string | null,
  parserVersion: string,
): Promise<string> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentParsedKeyForVersion(id, namespace, parserVersion);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }),
  );
  return key;
}

export async function putTempDocumentFinalizeReceipt(
  token: string,
  userId: string,
  namespace: string | null,
  body: Buffer,
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = tempDocumentUploadReceiptKey(token, userId, namespace);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function presignGet(
  id: string,
  namespace: string | null,
  options?: { expiresInSeconds?: number },
): Promise<string> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = documentKey(id, namespace);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
    { expiresIn: Math.max(30, Math.min(options?.expiresInSeconds ?? 300, 3600)) },
  );
}

export async function putDocumentBlob(
  id: string,
  body: Buffer,
  contentType: string,
  namespace: string | null,
  options?: { ifNoneMatch?: boolean },
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
      ...(options?.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }),
  );
}

export async function putTempDocumentBlob(
  token: string,
  userId: string,
  body: Buffer,
  contentType: string,
  namespace: string | null,
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = tempDocumentUploadKey(token, userId, namespace);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function copyTempDocumentBlobToDocument(
  token: string,
  userId: string,
  documentId: string,
  namespace: string | null,
  contentType: string,
  options?: { ifNoneMatch?: boolean },
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  await client.send(
    new CopyObjectCommand({
      Bucket: cfg.bucket,
      Key: documentKey(documentId, namespace),
      CopySource: `${cfg.bucket}/${tempDocumentUploadKey(token, userId, namespace)}`,
      ContentType: contentType,
      MetadataDirective: 'REPLACE',
      ServerSideEncryption: 'AES256',
      ...(options?.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }),
  );
}

export async function deleteDocumentBlob(id: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const parsedKey = documentParsedKey(id, namespace);
  const legacyParsedKey = legacyDocumentParsedKey(id, namespace);
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  const parsedPrefix = `${cfg.prefix}/documents_v1/parsed_v2/${nsSegment}${id}/`;

  await deleteDocumentPrefix(parsedPrefix);
  await deleteDocumentPrefix(`${key}/`);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: parsedKey }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: legacyParsedKey }));
  // Delete the source after the initial derived-artifact cleanup, then sweep
  // parsed output once more to catch a worker that finished during deletion.
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  // The source blob is already gone at this point. Treat the final sweep as a
  // best-effort cleanup: if it throws, rethrowing would make callers roll back
  // the document row even though the source is deleted, so log and swallow.
  try {
    await deleteDocumentPrefix(parsedPrefix);
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'documents.blob_delete.final_parsed_sweep.failed',
      msg: 'Failed final parsed-output sweep after document deletion',
      step: 'delete_document_parsed_prefix_final',
      context: { parsedPrefix },
      error,
    });
  }
}

export async function deleteTempDocumentUpload(token: string, userId: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: tempDocumentUploadKey(token, userId, namespace) }));
}

export async function deleteTempDocumentFinalizeReceipt(token: string, userId: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: tempDocumentUploadReceiptKey(token, userId, namespace) }));
}

export function isMissingBlobError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (maybe.$metadata?.httpStatusCode === 404) return true;
  if (maybe.name === 'NotFound' || maybe.name === 'NoSuchKey') return true;
  if (maybe.Code === 'NotFound' || maybe.Code === 'NoSuchKey') return true;
  return false;
}

export async function deleteDocumentPrefix(prefix: string): Promise<number> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const cleanedPrefix = prefix.replace(/^\/+/, '');
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: cleanedPrefix,
        ContinuationToken: continuationToken,
      }),
    );

    const keys = (listRes.Contents ?? [])
      .map((item) => item.Key)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (keys.length > 0) {
      const deleteRes = await client.send(
        new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: {
            Objects: keys.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      const errors = deleteRes.Errors ?? [];
      if (errors.length > 0) {
        const details = errors
          .map((e) => `${e.Key ?? '?'} (${e.Code ?? 'Unknown'}: ${e.Message ?? 'no message'})`)
          .join('; ');
        throw new Error(
          `Failed deleting ${errors.length} document storage object(s) under prefix "${cleanedPrefix}": ${details}`,
        );
      }
      deleted += keys.length;
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

/**
 * List the source document blobs under a namespace (content-addressed objects
 * directly beneath `documents_v1/`, excluding the `parsed_v2/` and `ns/`
 * subtrees via the `/` delimiter). Used by the orphaned-blob reaper.
 */
export async function listDocumentSourceBlobs(
  namespace: string | null,
  options?: { signal?: AbortSignal },
): Promise<Array<{ id: string; lastModifiedMs: number }>> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  const prefix = `${cfg.prefix}/documents_v1/${nsSegment}`;
  const out: Array<{ id: string; lastModifiedMs: number }> = [];
  let continuationToken: string | undefined;

  do {
    options?.signal?.throwIfAborted();
    const listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }),
      { abortSignal: options?.signal },
    );

    for (const item of listRes.Contents ?? []) {
      const key = item.Key;
      if (!key) continue;
      const id = key.slice(prefix.length);
      if (!isValidDocumentId(id)) continue;
      out.push({ id, lastModifiedMs: item.LastModified?.getTime() ?? 0 });
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return out;
}

/**
 * Delete every temporary upload object (across all users) older than the given
 * cutoff. Used by the cleanup-temp-uploads scheduled task.
 */
export async function deleteAllExpiredTempDocumentUploads(
  namespace: string | null,
  olderThanMs: number,
  options?: { signal?: AbortSignal },
): Promise<number> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  const prefix = `${cfg.prefix}/document_uploads_temp_v1/${nsSegment}`;
  let continuationToken: string | undefined;
  let deleted = 0;

  do {
    options?.signal?.throwIfAborted();
    const listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
      { abortSignal: options?.signal },
    );

    const batch: string[] = [];
    for (const item of listRes.Contents ?? []) {
      const key = item.Key;
      const lastModified = item.LastModified?.getTime() ?? 0;
      if (!key || lastModified <= 0 || lastModified >= olderThanMs) continue;
      batch.push(key);
    }

    if (batch.length > 0) {
      const deleteRes = await client.send(
        new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
        { abortSignal: options?.signal },
      );
      if (deleteRes.Errors?.length) {
        throw new Error(
          `Failed to delete temporary uploads from bucket "${cfg.bucket}" `
          + `(keys: ${JSON.stringify(batch)}, errors: ${JSON.stringify(deleteRes.Errors)})`,
        );
      }
      deleted += batch.length;
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
