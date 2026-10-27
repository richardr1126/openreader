import { clonedVoiceKey, clonedVoiceId, CLONED_VOICE_MAX_JSON_BYTES, validateReferenceWav, type StoredClonedVoice, type VoiceReferenceAudio } from '@openreader/tts/cloned-voices';
import type { TTSSegmentSettings } from '@openreader/tts/types';

/** Resolve only inside execution; samples never enter settings hashes, events or jobs. */
export async function resolveClonedVoice(input: {
  settings: TTSSegmentSettings;
  userId?: string;
  prefix: string;
  readObject: (key: string) => Promise<Uint8Array>;
}): Promise<{ voice: string; referenceAudio?: VoiceReferenceAudio }> {
  if (!input.settings.voice.startsWith('clone:')) return { voice: input.settings.voice };
  if (!input.userId || !clonedVoiceId(input.settings.voice)) throw new Error('Cloned voice is unavailable');
  const bytes = await input.readObject(clonedVoiceKey(input.prefix, input.userId, input.settings.voice));
  if (bytes.length > CLONED_VOICE_MAX_JSON_BYTES) throw new Error('Cloned voice exceeded its size limit');
  const voice = JSON.parse(new TextDecoder().decode(bytes)) as StoredClonedVoice;
  if (voice.id !== input.settings.voice || voice.providerRef !== input.settings.providerRef
    || voice.providerType !== input.settings.providerType || voice.model !== input.settings.ttsModel) {
    throw new Error('Cloned voice belongs to another provider or model');
  }
  if (!['fish-audio', 'openrouter'].includes(voice.providerType) || !voice.audio) throw new Error('Cloned voice sample is unavailable');
  validateReferenceWav(Buffer.from(voice.audio, 'base64'));
  return { voice: 'default', referenceAudio: { audio: voice.audio, transcript: voice.transcript } };
}
