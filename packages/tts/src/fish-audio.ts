import type { VoiceReferenceAudio } from './cloned-voices';

/** Fish accepts binary reference audio through MessagePack, not its JSON path.
 * This encodes only the fixed speech schema, with bounded strings and one WAV;
 * it is deliberately not a general object serializer. */
export function fishReferenceRequest(input: {
  text: string; speed: number; reference: VoiceReferenceAudio; language?: string;
}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const byte = (value: number) => chunks.push(Uint8Array.of(value));
  const length = (tag: number, value: number, width: 2 | 4) => {
    const header = new Uint8Array(width + 1); header[0] = tag;
    const view = new DataView(header.buffer);
    if (width === 2) view.setUint16(1, value); else view.setUint32(1, value);
    chunks.push(header);
  };
  const string = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length < 32) byte(0xa0 + bytes.length);
    else if (bytes.length < 256) chunks.push(Uint8Array.of(0xd9, bytes.length));
    else if (bytes.length < 65_536) length(0xda, bytes.length, 2);
    else length(0xdb, bytes.length, 4);
    chunks.push(bytes);
  };
  byte(input.language ? 0x85 : 0x84);
  string('text'); string(input.text);
  string('format'); string('mp3');
  string('references'); byte(0x91); byte(0x82);
  string('audio'); const audio = Buffer.from(input.reference.audio, 'base64');
  length(0xc6, audio.length, 4); chunks.push(audio);
  string('text'); string(input.reference.transcript);
  string('prosody'); byte(0x81); string('speed');
  const speed = new Uint8Array(9); speed[0] = 0xcb;
  new DataView(speed.buffer).setFloat64(1, Math.max(0.5, Math.min(2, input.speed)));
  chunks.push(speed);
  if (input.language) { string('language'); string(input.language); }
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
