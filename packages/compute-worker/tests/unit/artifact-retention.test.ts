import { describe, expect, test } from 'vitest';

import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { expireArtifactFoldersUnderRoot } from '../../src/storage/artifact-retention';

const DAY_MS = 24 * 60 * 60 * 1000;

function storageWith(objects: Record<string, number>) {
  const modifiedAt = new Map(Object.entries(objects));
  return {
    modifiedAt,
    storage: {
      async *listPrefixPages(prefix: string) {
        yield [...modifiedAt.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, lastModifiedMs]) => ({ key, size: 1, lastModifiedMs }));
      },
      async deleteObject(key: string) { modifiedAt.delete(key); },
    } as unknown as ArtifactStorage,
  };
}

describe('expireArtifactFoldersUnderRoot', () => {
  test('expires folders by their newest object, including ones with no metadata', async () => {
    const now = Date.now();
    const root = 'p/document_conversions_v1/';
    const { storage, modifiedAt } = storageWith({
      // Completed long ago.
      [`${root}docx/ns/_default/old/artifact.pdf`]: now - 3 * DAY_MS,
      [`${root}docx/ns/_default/old/metadata.json`]: now - 3 * DAY_MS,
      // Crashed before metadata was written.
      [`${root}docx/ns/_default/crashed/artifact.pdf`]: now - 2 * DAY_MS,
      // An old object beside a fresh one is still in use.
      [`${root}docx/ns/_default/fresh/artifact.pdf`]: now - 3 * DAY_MS,
      [`${root}docx/ns/_default/fresh/metadata.json`]: now - 60_000,
      ['p/account_exports_v1/users/u/x/artifact.zip']: now - 30 * DAY_MS,
    });

    const result = await expireArtifactFoldersUnderRoot({ storage, root, maxAgeMs: DAY_MS, now });

    expect(result).toEqual({ expiredArtifacts: 2, deletedObjects: 3 });
    expect([...modifiedAt.keys()].sort()).toEqual([
      'p/account_exports_v1/users/u/x/artifact.zip',
      `${root}docx/ns/_default/fresh/artifact.pdf`,
      `${root}docx/ns/_default/fresh/metadata.json`,
    ]);
  });

  test('keeps an object written into an expired folder between the passes', async () => {
    const now = Date.now();
    const root = 'p/account_exports_v1/';
    const old = `${root}users/u/a/artifact.zip`;
    const late = `${root}users/u/a/manifest.json`;
    const modifiedAt = new Map([[old, now - 30 * DAY_MS]]);
    let listings = 0;
    const storage = {
      async *listPrefixPages() {
        listings += 1;
        if (listings === 2) modifiedAt.set(late, now);
        yield [...modifiedAt.entries()].map(([key, lastModifiedMs]) => ({ key, size: 1, lastModifiedMs }));
      },
      async deleteObject(key: string) { modifiedAt.delete(key); },
    } as unknown as ArtifactStorage;

    const result = await expireArtifactFoldersUnderRoot({ storage, root, maxAgeMs: DAY_MS, now });

    expect(result).toEqual({ expiredArtifacts: 1, deletedObjects: 1 });
    expect([...modifiedAt.keys()]).toEqual([late]);
  });
});
