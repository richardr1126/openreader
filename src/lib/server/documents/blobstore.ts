import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

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
  if (!isValidDocumentId(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }
  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/documents_v1/parsed_v1/${nsSegment}${id}.json`;
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
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentParsedKey(id, namespace);
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
    }),
  );
}

export async function deleteDocumentBlob(id: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentKey(id, namespace);
  const parsedKey = documentParsedKey(id, namespace);
  const legacyParsedKey = legacyDocumentParsedKey(id, namespace);

  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: parsedKey })).catch(() => undefined);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: legacyParsedKey })).catch(() => undefined);
  await deleteDocumentPrefix(`${key}/`).catch(() => undefined);
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
      deleted += deleteRes.Deleted?.length ?? 0;
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
