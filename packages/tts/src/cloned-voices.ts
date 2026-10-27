/** Private reference media is stored separately from preferences and queued jobs. */
export const CLONED_VOICE_PREFIX = 'clone:';
export const CLONED_VOICE_MAX_BYTES = 768_044;
export const CLONED_VOICE_MAX_JSON_BYTES = 1_040_000;
export interface ClonedVoice {
  id: string;
  name: string;
  providerRef: string;
  providerType: 'fish-audio' | 'openrouter';
  model: string;
}
export interface StoredClonedVoice extends ClonedVoice {
  transcript: string;
  /** WAV, 24 kHz, signed 16-bit mono, at most sixteen seconds. */
  audio: string;
}
export interface VoiceReferenceAudio { audio: string; transcript: string }

export function clonedVoiceId(value: string): string | null {
  return /^clone:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.slice(6) : null;
}
export function clonedVoicesPrefix(prefix: string, userId: string): string {
  return `${prefix}/cloned_voices_v1/users/${encodeURIComponent(userId)}/`;
}
export function clonedVoiceKey(prefix: string, userId: string, voice: string): string {
  const id = clonedVoiceId(voice);
  if (!id) throw new Error('Invalid cloned voice ID');
  return `${clonedVoicesPrefix(prefix, userId)}${id}.json`;
}
export function validateVoiceName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\r\n]/.test(value)) {
    throw new Error('Use a voice name of up to 80 characters on one line.');
  }
  return value.trim();
}
/** A fixed format bounds both duration and decoded memory without running a decoder in Next.js. */
export function validateReferenceWav(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (start: number, text: string) => [...text].every((c, i) => bytes[start + i] === c.charCodeAt(0));
  if (bytes.length < 44 + 24_000 * 2 || bytes.length > CLONED_VOICE_MAX_BYTES
    || !label(0, 'RIFF') || !label(8, 'WAVEfmt ') || !label(36, 'data')
    || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== 24_000 || view.getUint32(28, true) !== 48_000
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44 || bytes.length % 2) {
    throw new Error('Use a WAV sample of 1–16 seconds, 24 kHz, 16-bit mono.');
  }
}
