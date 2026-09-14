import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  conflict: vi.fn(),
  returning: vi.fn(),
  enqueueDocumentPreview: vi.fn(),
  deleteDocumentTtsSegmentCache: vi.fn(),
}));

vi.mock('@openreader/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: mocks.selectLimit }),
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({
        onConflictDoUpdate: (input: unknown) => {
          mocks.conflict(input);
          return { returning: mocks.returning };
        },
      }),
    })),
  },
}));

vi.mock('@/lib/server/documents/previews', () => ({
  enqueueDocumentPreview: mocks.enqueueDocumentPreview,
}));

vi.mock('@/lib/server/tts/segments-cache', () => ({
  deleteDocumentTtsSegmentCache: mocks.deleteDocumentTtsSegmentCache,
}));

vi.mock('@/lib/server/logger', () => ({
  errorToLog: vi.fn((error: unknown) => error),
  serverLogger: { warn: vi.fn() },
}));

import { registerUploadedDocument } from '../../src/lib/server/documents/register-upload';

const baseInput = {
  documentId: 'doc-1',
  userId: 'user-1',
  namespace: null,
  name: 'Document.pdf',
  type: 'pdf' as const,
  size: 42,
  lastModified: 123,
};

describe('uploaded document folder registration', () => {
  beforeEach(() => {
    mocks.selectLimit.mockReset();
    mocks.conflict.mockReset();
    mocks.returning.mockReset();
    mocks.enqueueDocumentPreview.mockReset();
    mocks.deleteDocumentTtsSegmentCache.mockReset();
    mocks.selectLimit.mockResolvedValue([{ lastModified: 123 }]);
    mocks.enqueueDocumentPreview.mockResolvedValue(undefined);
    mocks.deleteDocumentTtsSegmentCache.mockResolvedValue(undefined);
  });

  test('preserves the existing folder when folderId is omitted', async () => {
    mocks.returning.mockResolvedValue([{ folderId: 'folder-existing' }]);

    await expect(registerUploadedDocument(baseInput)).resolves.toMatchObject({
      folderId: 'folder-existing',
    });

    const [{ set }] = mocks.conflict.mock.calls[0] as [{ set: Record<string, unknown> }];
    expect(set).not.toHaveProperty('folderId');
  });

  test('removes the existing folder when folderId is explicitly null', async () => {
    mocks.returning.mockResolvedValue([{ folderId: null }]);

    await expect(registerUploadedDocument({ ...baseInput, folderId: null })).resolves.toHaveProperty('folderId', undefined);

    const [{ set }] = mocks.conflict.mock.calls[0] as [{ set: Record<string, unknown> }];
    expect(set).toHaveProperty('folderId', null);
  });
});
