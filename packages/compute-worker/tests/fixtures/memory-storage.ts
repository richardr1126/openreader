import type { ArtifactStorage } from '../../src/infrastructure/storage';

/** Delimiter listing over an in-memory key set, matching `ArtifactStorage.listChildPrefixes`. */
export function listMemoryChildPrefixes(
  keys: Iterable<string>,
  prefix: string,
  options?: { startAfter?: string; limit?: number },
): string[] {
  const children = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) children.add(rest.slice(0, slash));
  }
  return [...children]
    .sort()
    .filter((child) => options?.startAfter === undefined || child > options.startAfter)
    .slice(0, options?.limit ?? Infinity);
}

/**
 * In-memory `ArtifactStorage` for tests that only exercise object keys and
 * bytes. Its operations are bound fields, like the real storage's closures, so
 * callers may pass one on its own (`storage.objectExists`).
 */
export class MemoryArtifactStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();
  readonly modifiedAt = new Map<string, number>();

  listChildPrefixes = async (
    prefix: string,
    options?: { startAfter?: string; limit?: number },
  ): Promise<string[]> => listMemoryChildPrefixes(this.objects.keys(), prefix, options);

  readObject = async (key: string): Promise<ArrayBuffer> => {
    const value = this.objects.get(key);
    if (!value) throw new Error(`not found: ${key}`);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  };

  objectExists = async (key: string): Promise<boolean> => this.objects.has(key);

  deleteObject = async (key: string): Promise<void> => {
    this.objects.delete(key);
  };

  listPrefix = async (prefix: string): Promise<string[]> =>
    [...this.objects.keys()].filter((key) => key.startsWith(prefix));

  listPrefixPages = async function* (this: MemoryArtifactStorage, prefix: string) {
    yield [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.byteLength, lastModifiedMs: this.modifiedAt.get(key) ?? 0 }));
  };

  putObject = async (key: string, body: Buffer | Uint8Array): Promise<void> => {
    this.objects.set(key, Buffer.from(body));
  };

  putFile = async (): Promise<void> => { throw new Error('not implemented'); };
  putParsedPdf = async (): Promise<string> => { throw new Error('not implemented'); };
}
