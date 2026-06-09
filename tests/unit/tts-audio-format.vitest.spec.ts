import { describe, expect, it } from 'vitest';
import { sniffAudioFormat } from '@/lib/server/tts/audio-format';

function bytes(...values: number[]): Buffer {
  return Buffer.from(values);
}

describe('sniffAudioFormat', () => {
  it('detects wav from RIFF/WAVE header', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      bytes(0x24, 0x00, 0x00, 0x00),
      Buffer.from('WAVE'),
    ]);
    expect(sniffAudioFormat(wav)).toBe('wav');
  });

  it('detects ogg', () => {
    expect(sniffAudioFormat(Buffer.from('OggS....'))).toBe('ogg');
  });

  it('detects flac', () => {
    expect(sniffAudioFormat(Buffer.from('fLaC....'))).toBe('flac');
  });

  it('detects ID3-tagged mp3 with a full 10-byte header', () => {
    // "ID3" + version(2) + flags(1) + size(4) = 10 bytes
    const id3 = Buffer.concat([Buffer.from('ID3'), bytes(0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21)]);
    expect(sniffAudioFormat(id3)).toBe('mp3');
  });

  it('does not claim mp3 on a truncated ID3 header', () => {
    expect(sniffAudioFormat(Buffer.concat([Buffer.from('ID3'), bytes(0x03, 0x00)]))).toBe('unknown');
  });

  it('does not claim mp3 on a frame sync with an invalid header', () => {
    // valid 11-bit sync + nonzero layer, but bitrate index 0b1111 ("bad")
    expect(sniffAudioFormat(bytes(0xff, 0xfb, 0xf0, 0x00))).toBe('unknown');
  });

  it('detects mp3 frame sync (MPEG-1 Layer III)', () => {
    expect(sniffAudioFormat(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('mp3');
  });

  it('detects mp3 frame sync (MPEG-2 Layer III)', () => {
    expect(sniffAudioFormat(bytes(0xff, 0xf3, 0x00, 0x00))).toBe('mp3');
  });

  it('distinguishes ADTS aac from mp3 via the layer bits', () => {
    expect(sniffAudioFormat(bytes(0xff, 0xf1, 0x00, 0x00))).toBe('aac');
    expect(sniffAudioFormat(bytes(0xff, 0xf9, 0x00, 0x00))).toBe('aac');
  });

  it('returns unknown for unrecognized or short buffers', () => {
    expect(sniffAudioFormat(bytes(0x00, 0x01, 0x02, 0x03))).toBe('unknown');
    expect(sniffAudioFormat(bytes(0x00))).toBe('unknown');
    expect(sniffAudioFormat(Buffer.alloc(0))).toBe('unknown');
  });
});
