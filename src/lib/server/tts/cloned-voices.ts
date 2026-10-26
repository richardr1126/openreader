import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { clonedVoiceKey, clonedVoicesPrefix, CLONED_VOICE_MAX_JSON_BYTES, type StoredClonedVoice, type ClonedVoice } from '@openreader/tts/cloned-voices';
import { getS3Config, getS3InternalClient, isS3Configured } from '@/lib/server/storage/s3';

export async function readClonedVoice(userId: string, id: string): Promise<StoredClonedVoice> {
  const config = getS3Config();
  const result = await getS3InternalClient().send(new GetObjectCommand({ Bucket: config.bucket,
    Key: clonedVoiceKey(config.prefix, userId, id) }));
  if (!result.Body || (result.ContentLength ?? 0) > CLONED_VOICE_MAX_JSON_BYTES) throw new Error('Invalid cloned voice');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > CLONED_VOICE_MAX_JSON_BYTES) throw new Error('Invalid cloned voice');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as StoredClonedVoice;
}
export async function writeClonedVoice(userId: string, voice: StoredClonedVoice): Promise<void> {
  const config = getS3Config();
  const body = Buffer.from(JSON.stringify(voice));
  if (body.length > CLONED_VOICE_MAX_JSON_BYTES) throw new Error('Cloned voice exceeded its size limit');
  await getS3InternalClient().send(new PutObjectCommand({ Bucket: config.bucket,
    Key: clonedVoiceKey(config.prefix, userId, voice.id), Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
}
export function clonedVoiceSummary(voice: StoredClonedVoice): ClonedVoice {
  return { id: voice.id, name: voice.name, providerRef: voice.providerRef, providerType: voice.providerType, model: voice.model };
}
export async function listClonedVoices(userId: string): Promise<ClonedVoice[]> {
  const config = getS3Config();
  const result = await getS3InternalClient().send(new ListObjectsV2Command({ Bucket: config.bucket,
    Prefix: clonedVoicesPrefix(config.prefix, userId), MaxKeys: 100 }));
  const voices: ClonedVoice[] = [];
  for (const object of result.Contents ?? []) {
    const id = object.Key?.split('/').pop()?.replace(/\.json$/, '');
    if (id) voices.push(clonedVoiceSummary(await readClonedVoice(userId, `clone:${id}`)));
  }
  return voices;
}
export async function deleteClonedVoice(userId: string, id: string): Promise<void> {
  const config = getS3Config();
  await getS3InternalClient().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: clonedVoiceKey(config.prefix, userId, id) }));
}

/** Claim references before preferences move; a sign-in must not strand a saved voice. */
export async function transferClonedVoices(fromUserId: string, toUserId: string): Promise<void> {
  if (fromUserId === toUserId || !isS3Configured()) return;
  const voices = await listClonedVoices(fromUserId);
  for (const voice of voices) await writeClonedVoice(toUserId, await readClonedVoice(fromUserId, voice.id));
  for (const voice of voices) await deleteClonedVoice(fromUserId, voice.id);
}
