import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  roots: {
    docstoreDir: '',
    documentsDir: '',
    audiobooksDir: '',
  },
}));

vi.mock('@/lib/server/storage/docstore-legacy', () => ({
  get DOCSTORE_DIR() {
    return hoisted.roots.docstoreDir;
  },
  get DOCUMENTS_V1_DIR() {
    return hoisted.roots.documentsDir;
  },
  get AUDIOBOOKS_V1_DIR() {
    return hoisted.roots.audiobooksDir;
  },
}));

describe('cleanupClaimedLegacyFsSources', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'openreader-legacy-cleanup-'));
    hoisted.roots = {
      docstoreDir: path.join(tempRoot, 'docstore'),
      documentsDir: path.join(tempRoot, 'documents_v1'),
      audiobooksDir: path.join(tempRoot, 'audiobooks_v1'),
    };
    await fsp.mkdir(hoisted.roots.docstoreDir, { recursive: true });
    await fsp.mkdir(hoisted.roots.documentsDir, { recursive: true });
    await fsp.mkdir(hoisted.roots.audiobooksDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  test('removes only claimed legacy document and audiobook sources', async () => {
    const namespace = 'ns1';
    const docsNsDir = path.join(hoisted.roots.documentsDir, namespace);
    const docstoreNsDir = path.join(hoisted.roots.docstoreDir, namespace);
    const audiobooksNsDir = path.join(hoisted.roots.audiobooksDir, namespace);
    await fsp.mkdir(docsNsDir, { recursive: true });
    await fsp.mkdir(docstoreNsDir, { recursive: true });
    await fsp.mkdir(audiobooksNsDir, { recursive: true });

    const doc1Bytes = Buffer.from('claimed-doc-1');
    const doc1Id = createHash('sha256').update(doc1Bytes).digest('hex');
    const doc1Path = path.join(docsNsDir, 'legacy-random-name.pdf');
    await fsp.writeFile(doc1Path, doc1Bytes);

    const doc2Bytes = Buffer.from('claimed-doc-2');
    const doc2Id = createHash('sha256').update(doc2Bytes).digest('hex');
    const doc2MetaPath = path.join(docstoreNsDir, 'legacy-doc-2.json');
    const doc2ContentPath = path.join(docstoreNsDir, 'legacy-doc-2.pdf');
    await fsp.writeFile(doc2MetaPath, JSON.stringify({
      id: 'legacy-doc-2',
      name: 'legacy-doc-2.pdf',
      size: doc2Bytes.length,
      lastModified: Date.now(),
      type: 'pdf',
    }));
    await fsp.writeFile(doc2ContentPath, doc2Bytes);

    const keepBytes = Buffer.from('keep-doc');
    const keepId = createHash('sha256').update(keepBytes).digest('hex');
    const keepPath = path.join(docsNsDir, `${keepId}__keep.pdf`);
    await fsp.writeFile(keepPath, keepBytes);

    const claimedBookDir = path.join(audiobooksNsDir, 'book-1-audiobook');
    const keepBookDir = path.join(docstoreNsDir, 'book-2-audiobook');
    await fsp.mkdir(claimedBookDir, { recursive: true });
    await fsp.mkdir(keepBookDir, { recursive: true });
    await fsp.writeFile(path.join(claimedBookDir, '0001__Chapter%201.mp3'), 'audio');
    await fsp.writeFile(path.join(keepBookDir, '0001__Chapter%201.mp3'), 'audio');

    const { cleanupClaimedLegacyFsSources } = await import('../../src/lib/server/user/legacy-fs-claim-cleanup');
    const result = await cleanupClaimedLegacyFsSources({
      documentIds: [doc1Id, doc2Id],
      audiobookIds: ['book-1'],
      namespace,
    });

    expect(result).toEqual({
      deletedDocumentPaths: 3,
      deletedAudiobookDirs: 1,
    });
    expect(fs.existsSync(doc1Path)).toBe(false);
    expect(fs.existsSync(doc2MetaPath)).toBe(false);
    expect(fs.existsSync(doc2ContentPath)).toBe(false);
    expect(fs.existsSync(keepPath)).toBe(true);
    expect(fs.existsSync(claimedBookDir)).toBe(false);
    expect(fs.existsSync(keepBookDir)).toBe(true);
  });
});
