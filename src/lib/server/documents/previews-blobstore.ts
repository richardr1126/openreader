import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { deleteDocumentPrefix, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents/blobstore';
import { getS3Client, getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';

const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const DEFAULT_NAMESPACE_SEGMENT = '_default';

export const DOCUMENT_PREVIEW_VARIANT = 'card-240-jpeg';
export const DOCUMENT_PREVIEW_FILE_NAME = 'card-240.jpg';
export const DOCUMENT_PREVIEW_CONTENT_TYPE = 'image/jpeg';
export const DOCUMENT_PREVIEW_WIDTH = 240;

function sanitizeNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  if (!SAFE_NAMESPACE_REGEX.test(namespace)) return null;
  return namespace;
}

function namespaceSegment(namespace: string | null): string {
  const safe = sanitizeNamespace(namespace);
  return safe ?? DEFAULT_NAMESPACE_SEGMENT;
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

export function documentPreviewPrefix(documentId: string, namespace: string | null): string {
  if (!isValidDocumentId(documentId)) {
    throw new Error(`Invalid document id: ${documentId}`);
  }

  const cfg = getS3Config();
  const ns = namespaceSegment(namespace);
  return `${cfg.prefix}/document_previews_v1/ns/${ns}/${documentId}/`;
}

export function documentPreviewKey(documentId: string, namespace: string | null): string {
  return `${documentPreviewPrefix(documentId, namespace)}${DOCUMENT_PREVIEW_FILE_NAME}`;
}

export async function headDocumentPreview(
  documentId: string,
  namespace: string | null,
): Promise<{ contentLength: number; contentType: string | null; eTag: string | null }> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentPreviewKey(documentId, namespace);
  const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return {
    contentLength: Number(res.ContentLength ?? 0),
    contentType: res.ContentType ?? null,
    eTag: res.ETag ?? null,
  };
}

export async function getDocumentPreviewBuffer(documentId: string, namespace: string | null): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentPreviewKey(documentId, namespace);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return bodyToBuffer(res.Body);
}

export async function putDocumentPreviewBuffer(
  documentId: string,
  bytes: Buffer,
  namespace: string | null,
  options?: { ifNoneMatch?: boolean },
): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const key = documentPreviewKey(documentId, namespace);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: bytes,
      ContentType: DOCUMENT_PREVIEW_CONTENT_TYPE,
      ServerSideEncryption: 'AES256',
      ...(options?.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }),
  );
}

export async function presignDocumentPreviewGet(
  documentId: string,
  namespace: string | null,
  options?: { expiresInSeconds?: number },
): Promise<string> {
  const cfg = getS3Config();
  const client = getS3Client();
  const key = documentPreviewKey(documentId, namespace);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      ResponseContentType: DOCUMENT_PREVIEW_CONTENT_TYPE,
    }),
    { expiresIn: Math.max(30, Math.min(options?.expiresInSeconds ?? 300, 3600)) },
  );
}

export async function deleteDocumentPreviewArtifacts(documentId: string, namespace: string | null): Promise<number> {
  return deleteDocumentPrefix(documentPreviewPrefix(documentId, namespace));
}

export { isMissingBlobError };
