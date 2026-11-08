import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), scope: vi.fn(), file: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: mocks.auth }));
vi.mock('@/lib/server/tts/segments-auth', () => ({ resolveUserDocumentScope: mocks.scope }));
vi.mock('@/lib/server/audiobooks/request', () => ({ findAudiobookFile: mocks.file, isAudiobookFileId: (id: string) => /^[a-f0-9]{8,128}$/i.test(id) }));

const { resolveAudiobookDownload } = await import('@/lib/server/audiobooks/download');
const account = { user: { id: 'owner', name: 'Reader One', isAnonymous: false } };
const open = (documentId = 'DOC1234', artifactId = 'abcdef12') => resolveAudiobookDownload(new Headers(), documentId, artifactId);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(account);
  mocks.scope.mockResolvedValue({ readerType: 'pdf', storageUserId: 'owner' });
  mocks.file.mockResolvedValue({ dispositionFilename: 'book.mp3' });
});

test('a signed-out visitor is asked to sign in without any lookup', async () => {
  mocks.auth.mockResolvedValue({ user: null });
  expect(await open()).toEqual({ access: 'sign-in' });
  expect(mocks.scope).not.toHaveBeenCalled();
});

test('a guest without the document is asked to sign in, an account can switch', async () => {
  mocks.scope.mockResolvedValue(null);
  expect(await open()).toEqual({ access: 'denied', accountName: 'Reader One' });
  mocks.auth.mockResolvedValue({ user: { id: 'guest', name: 'Guest', isAnonymous: true } });
  expect(await open()).toEqual({ access: 'sign-in' });
  expect(mocks.file).not.toHaveBeenCalled();
});

test('the owner gets the file from the authorized route', async () => {
  expect(await open()).toEqual({ access: 'ready', webPath: '/pdf/doc1234', fileUrl: '/api/v1/documents/doc1234/audiobooks/files/abcdef12', filename: 'book.mp3' });
  expect(mocks.scope).toHaveBeenCalledWith({ userId: 'owner', isAnonymous: false }, 'doc1234');
});

test('a missing, malformed or unreadable file sends the owner back to the document', async () => {
  const missing = { access: 'missing', webPath: '/pdf/doc1234' };
  mocks.file.mockResolvedValueOnce(null);
  expect(await open()).toEqual(missing);
  mocks.file.mockRejectedValueOnce(new Error('worker offline'));
  expect(await open()).toEqual(missing);
  mocks.file.mockClear();
  expect(await open('DOC1234', '../secret')).toEqual(missing);
  expect(mocks.file).not.toHaveBeenCalled();
});
