import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getS3Client, getS3Config } from '@/lib/server/storage/s3';

const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const SAFE_BOOK_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const SAFE_USER_ID_REGEX = /^[a-zA-Z0-9._:-]{1,256}$/;

export type AudiobookBlobObject = {
  key: string;
  fileName: string;
  size: number;
  lastModified: number;
  eTag: string | null;
};

export type AudiobookBlobBody =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | { transformToByteArray: () => Promise<Uint8Array> };

function sanitizeNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  if (!SAFE_NAMESPACE_REGEX.test(namespace)) return null;
  return namespace;
}

function assertSafeBookId(bookId: string): void {
  if (!SAFE_BOOK_ID_REGEX.test(bookId)) {
    throw new Error(`Invalid audiobook id: ${bookId}`);
  }
}

function assertSafeUserId(userId: string): void {
  if (!SAFE_USER_ID_REGEX.test(userId)) {
    throw new Error(`Invalid user id for audiobook storage scope: ${userId}`);
  }
}

function assertSafeFileName(fileName: string): void {
  if (!fileName || fileName === '.' || fileName === '..' || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error(`Invalid audiobook file name: ${fileName}`);
  }
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return !!value && typeof value === 'object' && 'on' in value && typeof (value as NodeJS.ReadableStream).on === 'function';
}

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

export function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 412 || maybe.name === 'PreconditionFailed';
}

export function isMissingBlobError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (maybe.$metadata?.httpStatusCode === 404) return true;
  if (maybe.name === 'NotFound' || maybe.name === 'NoSuchKey') return true;
  if (maybe.Code === 'NotFound' || maybe.Code === 'NoSuchKey') return true;
  return false;
}

export function audiobookPrefix(bookId: string, userId: string, namespace: string | null): string {
  assertSafeBookId(bookId);
  assertSafeUserId(userId);
  const cfg = getS3Config();
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${cfg.prefix}/audiobooks_v1/${nsSegment}users/${encodeURIComponent(userId)}/${bookId}-audiobook/`;
}

export function audiobookKey(bookId: string, userId: string, fileName: string, namespace: string | null): string {
  assertSafeFileName(fileName);
  return `${audiobookPrefix(bookId, userId, namespace)}${fileName}`;
}

export async function listAudiobookObjects(bookId: string, userId: string, namespace: string | null): Promise<AudiobookBlobObject[]> {
  const cfg = getS3Config();
  const client = getS3Client();
  const prefix = audiobookPrefix(bookId, userId, namespace);
  let continuationToken: string | undefined;
  const objects: AudiobookBlobObject[] = [];

  do {
    const listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const entry of listRes.Contents ?? []) {
      const key = entry.Key;
      if (!key || !key.startsWith(prefix)) continue;
      const fileName = key.slice(prefix.length);
      if (!fileName || fileName.includes('/')) continue;
      objects.push({
        key,
        fileName,
        size: Number(entry.Size ?? 0),
        lastModified: entry.LastModified?.getTime() ?? 0,
        eTag: entry.ETag ?? null,
      });
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

export async function headAudiobookObject(
  bookId: string,
  userId: string,
  fileName: string,
  namespace: string | null,
): Promise<{ contentLength: number; contentType: string | null; eTag: string | null }> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = audiobookKey(bookId, userId, fileName, namespace);
  const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return {
    contentLength: Number(res.ContentLength ?? 0),
    contentType: res.ContentType ?? null,
    eTag: res.ETag ?? null,
  };
}

export async function getAudiobookObjectBuffer(bookId: string, userId: string, fileName: string, namespace: string | null): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = audiobookKey(bookId, userId, fileName, namespace);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return bodyToBuffer(res.Body);
}

export async function getAudiobookObjectStream(
  bookId: string,
  userId: string,
  fileName: string,
  namespace: string | null,
): Promise<AudiobookBlobBody> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = audiobookKey(bookId, userId, fileName, namespace);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return res.Body as AudiobookBlobBody;
}

export async function putAudiobookObject(
  bookId: string,
  userId: string,
  fileName: string,
  body: Buffer,
  contentType: string,
  namespace: string | null,
  options?: { ifNoneMatch?: boolean },
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = audiobookKey(bookId, userId, fileName, namespace);
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

export async function deleteAudiobookObject(bookId: string, userId: string, fileName: string, namespace: string | null): Promise<void> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = audiobookKey(bookId, userId, fileName, namespace);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

export async function deleteAudiobookPrefix(prefix: string): Promise<number> {
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
