import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { getS3Config, getS3InternalClient } from '../../src/lib/server/storage/s3';

export async function deleteTestObjectPrefix(prefix: string): Promise<number> {
  const config = getS3Config();
  const client = getS3InternalClient();
  const cleanedPrefix = prefix.replace(/^\/+/, '');
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: cleanedPrefix,
      ContinuationToken: continuationToken,
    }));
    const keys = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

    if (keys.length > 0) {
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }));
      const errors = result.Errors ?? [];
      if (errors.length > 0) {
        const details = errors
          .map((error) => `${error.Key ?? '?'} (${error.Code ?? 'Unknown'}: ${error.Message ?? 'no message'})`)
          .join('; ');
        throw new Error(`Failed deleting ${errors.length} test object(s) under prefix "${cleanedPrefix}": ${details}`);
      }
      deleted += keys.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
