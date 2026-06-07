import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';

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

function bodyToReadableStream(body: unknown): ReadableStream<Uint8Array> {
  if (!body) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }

  if (typeof body === 'object' && body !== null && 'transformToWebStream' in body) {
    const maybe = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
    if (typeof maybe.transformToWebStream === 'function') {
      return maybe.transformToWebStream();
    }
  }

  if (body instanceof Uint8Array) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        controller.close();
      },
    });
  }
  if (body instanceof ArrayBuffer) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
  }

  if (isNodeReadableStream(body)) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        body.on('data', (chunk) => {
          if (Buffer.isBuffer(chunk)) {
            controller.enqueue(new Uint8Array(chunk));
            return;
          }
          if (typeof chunk === 'string') {
            controller.enqueue(new Uint8Array(Buffer.from(chunk)));
            return;
          }
          controller.enqueue(new Uint8Array(chunk as Uint8Array));
        });
        body.on('end', () => controller.close());
        body.on('error', (err) => controller.error(err));
      },
      cancel() {
        const nodeBody = body as NodeJS.ReadableStream & { destroy?: () => void };
        if (typeof nodeBody.destroy === 'function') {
          nodeBody.destroy();
        }
      },
    });
  }

  throw new Error('Unsupported S3 response body type');
}

export type TtsSegmentAudioObjectStream = {
  stream: ReadableStream<Uint8Array>;
  contentType: string | null;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  etag: string | null;
  lastModified: Date | null;
  statusCode: number;
};

export async function putTtsSegmentAudioObject(key: string, buffer: Buffer): Promise<void> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: buffer,
    ContentType: 'audio/mpeg',
    ServerSideEncryption: 'AES256',
  }));
}

export async function getTtsSegmentAudioObject(key: string): Promise<Buffer> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return bodyToBuffer(res.Body);
}

export async function getTtsSegmentAudioObjectStream(
  key: string,
  options?: { range?: string },
): Promise<TtsSegmentAudioObjectStream> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const res = await client.send(new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ...(options?.range ? { Range: options.range } : {}),
  }));
  return {
    stream: bodyToReadableStream(res.Body),
    contentType: res.ContentType ?? null,
    contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
    contentRange: typeof res.ContentRange === 'string' ? res.ContentRange : null,
    acceptRanges: typeof res.AcceptRanges === 'string' ? res.AcceptRanges : null,
    etag: typeof res.ETag === 'string' ? res.ETag : null,
    lastModified: res.LastModified ?? null,
    statusCode: res.$metadata.httpStatusCode ?? (options?.range ? 206 : 200),
  };
}

export async function presignTtsSegmentAudioGet(
  key: string,
  options?: { expiresInSeconds?: number },
): Promise<string> {
  const cfg = getS3Config();
  const client = getS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
    { expiresIn: Math.max(30, Math.min(options?.expiresInSeconds ?? 300, 3600)) },
  );
}

export async function deleteTtsSegmentAudioObjects(keys: string[]): Promise<number> {
  const uniqueKeys = Array.from(new Set(keys.filter((key) => typeof key === 'string' && key.length > 0)));
  if (uniqueKeys.length === 0) return 0;

  const cfg = getS3Config();
  const client = getS3ProxyClient();
  let deleted = 0;

  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const chunk = uniqueKeys.slice(i, i + 1000);
    const deleteRes = await client.send(
      new DeleteObjectsCommand({
        Bucket: cfg.bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    // With Quiet=true, many S3-compatible providers omit Deleted entries even on success.
    // Count attempted keys minus explicit per-key errors to avoid false partial-delete reports.
    const errored = deleteRes.Errors?.length ?? 0;
    deleted += Math.max(0, chunk.length - errored);
  }

  return deleted;
}

export async function deleteTtsSegmentPrefix(prefix: string): Promise<number> {
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
        throw new Error(`Failed deleting ${errors.length} TTS segment audio objects`);
      }
      // Quiet=true commonly omits Deleted entries on successful requests.
      deleted += keys.length;
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

export async function copyTtsSegmentPrefix(sourcePrefix: string, destinationPrefix: string): Promise<number> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const source = sourcePrefix.replace(/^\/+/, '');
  const destination = destinationPrefix.replace(/^\/+/, '');
  if (source === destination) return 0;

  let copied = 0;
  let continuationToken: string | undefined;
  // Track destination keys we have written so a mid-copy failure can be rolled
  // back, leaving no orphaned objects behind at the destination prefix.
  const copiedKeys: string[] = [];
  try {
    do {
      const listRes = await client.send(new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: source,
        ContinuationToken: continuationToken,
      }));
      const keys = (listRes.Contents ?? [])
        .map((item) => item.Key)
        .filter((value): value is string => typeof value === 'string' && value.startsWith(source));

      for (const key of keys) {
        const destinationKey = `${destination}${key.slice(source.length)}`;
        await client.send(new CopyObjectCommand({
          Bucket: cfg.bucket,
          Key: destinationKey,
          CopySource: `${cfg.bucket}/${key}`,
          ServerSideEncryption: 'AES256',
        }));
        copiedKeys.push(destinationKey);
        copied += 1;
      }

      continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    // Best-effort rollback of the partial copy; surface the original error.
    if (copiedKeys.length > 0) {
      await deleteTtsSegmentAudioObjects(copiedKeys).catch(() => {});
    }
    throw error;
  }

  return copied;
}
