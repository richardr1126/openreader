import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

type CentralEntry = {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
};

/**
 * Reads single small entries out of an in-memory ZIP (an EPUB container)
 * without a ZIP library. Only stored and deflated entries are supported, and
 * ZIP64 archives are refused; callers treat `null` as "metadata unavailable".
 */
export class ZipEntries {
  private constructor(
    private readonly bytes: Buffer,
    private readonly entries: Map<string, CentralEntry>,
  ) {}

  static open(bytes: Buffer): ZipEntries | null {
    const eocd = findEndOfCentralDirectory(bytes);
    if (eocd < 0) return null;
    const entryCount = bytes.readUInt16LE(eocd + 10);
    const directoryOffset = bytes.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff || directoryOffset >= bytes.length) return null;

    const entries = new Map<string, CentralEntry>();
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_ENTRY_SIGNATURE) return null;
      const method = bytes.readUInt16LE(cursor + 10);
      const compressedSize = bytes.readUInt32LE(cursor + 20);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
      const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      entries.set(name, { method, compressedSize, localHeaderOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipEntries(bytes, entries);
  }

  /** The entry's bytes as UTF-8 text, or null when absent, unsupported, or larger than `maxBytes`. */
  readText(name: string, maxBytes: number): string | null {
    const entry = this.entries.get(name) ?? this.findCaseInsensitive(name);
    if (!entry) return null;
    const header = entry.localHeaderOffset;
    if (header + 30 > this.bytes.length || this.bytes.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) return null;
    const dataStart = header + 30 + this.bytes.readUInt16LE(header + 26) + this.bytes.readUInt16LE(header + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.bytes.length) return null;
    const data = this.bytes.subarray(dataStart, dataEnd);
    try {
      if (entry.method === 0) return data.length <= maxBytes ? data.toString('utf8') : null;
      if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes }).toString('utf8');
    } catch {
      return null;
    }
    return null;
  }

  private findCaseInsensitive(name: string): CentralEntry | undefined {
    const wanted = name.toLowerCase();
    for (const [entryName, entry] of this.entries) {
      if (entryName.toLowerCase() === wanted) return entry;
    }
    return undefined;
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = bytes.length - EOCD_MIN_LENGTH; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}
