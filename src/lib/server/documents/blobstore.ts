import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Config } from '@/lib/server/storage/s3';

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

export async function presignPut(
  id: string,
  contentType: string,
  namespace: string | null,
): Promise<{ url: string; headers: Record<string, string> }> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = documentKey(id, namespace);
  const normalizedType = (contentType || 'application/octet-stream').trim() || 'application/octet-stream';

  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: normalizedType,
    IfNoneMatch: '*',
    ServerSideEncryption: 'AES256',
  });
  const url = await getSignedUrl(client, command, { expiresIn: 60 * 5 });

  return {
    url,
    headers: {
      'Content-Type': normalizedType,
      'If-None-Match': '*',
      'x-amz-server-side-encryption': 'AES256',
    },
  };
}

export async function headDocumentBlob(
  id: string,
  namespace: string | null,
): Promise<{ contentLength: number; contentType: string | null; eTag: string | null }> {
  const cfg = getS3Config();
  const client = getS3Client();
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
  const client = getS3Client();
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
  const client = getS3Client();
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
  const client = getS3Client();
  const key = documentKey(id, namespace);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );
  return res.Body as DocumentBlobBody;
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
  const client = getS3Client();
  const key = documentKey(id, namespace);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function deleteDocumentBlob(id: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = documentKey(id, namespace);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
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
  const client = getS3Client();
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
