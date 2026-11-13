import { NextRequest } from 'next/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { verifyUploadLink } from '@/lib/server/documents/upload-links';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), create: vi.fn(), voices: vi.fn(), providers: vi.fn(), start: vi.fn(), get: vi.fn(), stop: vi.fn(), caller: vi.fn(), intent: vi.fn(),
  worker: vi.fn(() => true), cached: vi.fn(), owner: vi.fn(), audiobooks: vi.fn(), deleteBook: vi.fn(), list: vi.fn(),
  update: vi.fn(), remove: vi.fn(), require: vi.fn(), prepare: vi.fn(), submit: vi.fn(),
  folders: vi.fn(), requireFolder: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(),
}));
vi.mock('@/lib/server/auth/auth', () => ({ getTrustedOrigins: () => ['http://localhost:3003'] }));
vi.mock('@/lib/server/auth/config', () => ({ getRequiredAuthEnv: () => ({ baseUrl: 'http://localhost:3003' }) }));
vi.mock('@/lib/server/auth/oauth', () => ({ oauthUrls: () => ({ mcpResource: 'http://localhost:3003/api/mcp', mcpMetadata: 'http://localhost:3003/.well-known/oauth-protected-resource/api/mcp' }) }));
vi.mock('@/lib/server/auth/oauth-access', () => ({ resolveOAuthAccess: mocks.access }));
vi.mock('@/lib/server/documents/create', () => ({ createDocument: mocks.create }));
vi.mock('@/lib/server/documents/request', async () => {
  const { apiCatchResponse } = await import('@/lib/server/api/responses');
  return { documentCaller: (principal: unknown) => ({ principal }), documentRequestFailure: (error: unknown, logger: never) =>
    apiCatchResponse(error, { logger, event: 'test', msg: 'Failed.', normalize: { code: 'TEST', errorClass: 'unknown' } }) };
});
vi.mock('@/lib/server/documents/resources', () => ({
  documentId: (value: string) => value, documentWebUrl: (document: { id: string }) => `http://localhost:3003/html/${document.id}`,
  listDocumentResources: mocks.list, requireDocument: mocks.require, describeDocument: vi.fn(), updateDocuments: mocks.update, removeDocuments: mocks.remove,
}));
vi.mock('@/lib/server/documents/uploads', () => ({ prepareDocumentUpload: mocks.prepare, submitDocumentUpload: mocks.submit, uploadId: (value: string) => value.toLowerCase() }));
vi.mock('@/lib/server/folders', () => ({ listFolders: mocks.folders, requireFolder: mocks.requireFolder, createFolder: mocks.createFolder, updateFolder: mocks.updateFolder, deleteFolder: mocks.deleteFolder,
  folderId: (value: string) => { if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Invalid folder ID.'); return value; } }));
vi.mock('@/lib/server/tts/voices', () => ({ listVoices: mocks.voices, listSpeechProviders: mocks.providers }));
vi.mock('@/lib/server/tts/cached-voices', () => ({ listCachedVoices: mocks.cached }));
vi.mock('@/lib/server/audiobooks/audiobooks', () => ({ ChapterNotFoundError: class extends Error {}, ChapterCommandError: class extends Error {},
  AudiobookBuildingError: class extends Error {}, getAudiobook: mocks.get, startAudiobook: mocks.start, stopAudiobook: mocks.stop,
  findAudiobookDocumentId: mocks.owner, listAudiobooks: mocks.audiobooks, deleteAudiobook: mocks.deleteBook,
  whenAudiobookFree: (run: () => Promise<unknown>) => run() }));
vi.mock('@/lib/server/audiobooks/request', async () => ({ audiobookCaller: mocks.caller, resolveAudiobookIntent: mocks.intent,
  parseAudiobookBody: (record: Record<string, unknown>) => ({ record, format: record.format ?? 'mp3', speed: record.speed ?? 1, chapterIndex: record.chapter ?? null }) }));
vi.mock('@/lib/server/compute-worker/client', () => ({ isComputeWorkerAvailable: mocks.worker, isComputeWorkerUnavailableError: () => false }));

const audiobook = { id: 'book', documentId: 'doc', status: 'generating', progress: 0.5, provider: 'kokoro', model: 'kokoro', voice: 'af_sky', modelSpeed: 1.2,
  requestedAt: '2026-11-12T00:00:00.000Z', format: 'mp3', speed: 1, chapter: null,
  downloadUrl: '/api/v1/documents/doc/audiobooks/files/secret', filename: null, webUrl: 'http://localhost:3003/html/doc', webDownloadUrl: null, retryAfterMs: null,
  generation: { state: 'generating', operationId: 'op-internal', issue: null }, segments: { completedSegments: 40 }, artifact: { state: 'none', operationId: null, issue: null } };

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/mcp/route');
  const response = await POST(new NextRequest('http://localhost:3003/api/mcp', { method: 'POST', headers: {
    authorization: 'Bearer token', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  expect(response.status).toBe(200);
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : /^data: (.+)$/m.exec(text)![1]).result;
}

const run = (name: string, command: string, extra: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: { command, ...extra } });

beforeEach(() => {
  vi.clearAllMocks();
  // Vite sets BASE_URL to its own base path under test.
  vi.stubEnv('BASE_URL', 'http://localhost:3003');
  mocks.worker.mockReturnValue(true);
  mocks.access.mockResolvedValue({ userId: 'user', isAnonymous: false, clientId: 'client', scopes: ['documents:read', 'documents:write', 'audio:generate'] });
  mocks.caller.mockResolvedValue({ scope: {} });
  mocks.intent.mockResolvedValue({ parsed: { settings: { providerRef: 'kokoro', ttsModel: 'kokoro', voice: 'af_sky', nativeSpeed: 1.2 } } });
  mocks.owner.mockResolvedValue('doc');
});

test('four tools split the commands by scope, and only the delete tool is destructive', async () => {
  const { tools } = await rpc('tools/list');
  expect(tools.map(({ name }: { name: string }) => name)).toEqual(['openreader', 'openreader_docs', 'openreader_delete', 'openreader_audio']);
  const [read, docs, remove, audio] = tools;
  expect(read.annotations).toMatchObject({ readOnlyHint: true });
  expect(docs.annotations).toMatchObject({ destructiveHint: false });
  expect(audio.annotations).toMatchObject({ destructiveHint: false });
  expect(remove.annotations).toMatchObject({ destructiveHint: true });
  expect(remove.description).toContain('docs delete <doc>');
  expect(docs.description).not.toContain('docs delete');
  expect(read.description).toContain('voices cached <doc>');
  expect(docs.description).toContain('docs add <source>');
  expect(audio.description).toContain('audiobook create <doc>');
  expect(read.description).not.toContain('audiobook create');
});

test('help lists commands, and a wrong line explains itself without doing any work', async () => {
  expect((await run('openreader', 'help')).content[0].text).toContain('audiobook view <id>');
  expect((await run('openreader_audio', 'audiobook create --help')).content[0].text).toContain('--model-speed');
  expect(await run('openreader', 'docs delete x')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('docs list, docs view') }] });
  expect(await run('openreader_audio', 'audiobook create doc --speed fast')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('--speed must be a number') }] });
  expect(await run('openreader_audio', 'audiobook create doc --voice kokoro/af_sky')).toMatchObject({ isError: true });
  expect(await run('openreader_audio', 'audiobook create')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Missing <doc>') }] });
  expect(mocks.start).not.toHaveBeenCalled();
});

test('docs list passes quoted searches through, and a leading tool name is ignored', async () => {
  mocks.list.mockResolvedValue({ data: [], nextCursor: null });
  await run('openreader', 'openreader docs list --search "dune messiah" --limit=5');
  expect(mocks.list.mock.calls[0][1].toString()).toBe('limit=5&q=dune+messiah');
  // A flag's value is never read as --help.
  await run('openreader', 'docs list --search --help');
  expect(mocks.list.mock.calls[1][1].toString()).toBe('limit=50&q=--help');
});

test('names keep their backslashes, and after "--" a name may start with a dash', async () => {
  mocks.createFolder.mockImplementation(async (_principal: unknown, body: { name: string }) => ({ id: 'f9', name: body.name }));
  await run('openreader_docs', 'folders create "C:\\Books\\ and \\"quotes\\""');
  expect(mocks.createFolder.mock.calls[0][1]).toEqual({ name: 'C:\\Books\\ and "quotes"' });
  await run('openreader_docs', 'folders create -- --drafts');
  expect(mocks.createFolder.mock.calls[1][1]).toEqual({ name: '--drafts' });
  await run('openreader_docs', 'folders create -- -h');
  expect(mocks.createFolder.mock.calls[2][1]).toEqual({ name: '-h' });
});

test('docs add imports a URL or the input text and returns a clickable link, not a v1 resource URL', async () => {
  mocks.create.mockResolvedValue({ id: 'upload', status: 'ready', statusUrl: '/api/v1/uploads/upload', document: { id: 'doc', name: 'page.md', type: 'html', size: 3, fileUrl: '/api/v1/documents/doc/file', webUrl: 'x' } });
  const result = await run('openreader_docs', 'docs add https://example.com/page --folder f1');
  expect(mocks.create.mock.calls[0][1]).toEqual({ source: { type: 'url', url: 'https://example.com/page' }, folderId: 'f1' });
  expect(result.structuredContent).toEqual({ status: 'ready', document: { id: 'doc', name: 'page.md', type: 'html', size: 3, author: null, language: null, folderId: null, webUrl: 'http://localhost:3003/html/doc' } });
  expect(JSON.stringify(result)).not.toContain('/api/v1');
  await run('openreader_docs', 'docs add - --name notes.md', { input: '# Notes' });
  expect(mocks.create.mock.calls[1][1]).toEqual({ source: { type: 'text', text: '# Notes' }, name: 'notes.md' });
  expect((await run('openreader_docs', 'docs add -')).isError).toBe(true);
  expect((await run('openreader_docs', 'docs add notes')).isError).toBe(true);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

const doc = { id: 'a'.repeat(64), name: 'Paper.pdf', type: 'pdf', size: 10, folderId: 'f1' };

test('docs upload gives the upload page, and with a name and size a one-time URL that docs add then registers', async () => {
  const page = await run('openreader_docs', 'docs upload --folder f1');
  expect(page.structuredContent).toMatchObject({ uploadPageUrl: 'http://localhost:3003/app/upload/f1' });
  expect(mocks.prepare).not.toHaveBeenCalled();

  const id = '0b5e1a2c-3d4e-4f50-8a6b-7c8d9e0f1a2b';
  vi.stubEnv('AUTH_SECRET', 'test-auth-secret');
  const now = Date.now();
  mocks.prepare.mockResolvedValue({ id, url: `/api/v1/uploads/${id}/file`, headers: { 'Content-Type': 'application/pdf' }, expiresAt: now + 60 * 60 * 1000 });
  const prepared = (await run('openreader_docs', "docs upload --name \"Bob's paper.pdf\" --size 10")).structuredContent;
  expect(mocks.prepare.mock.calls[0][1]).toEqual({ name: "Bob's paper.pdf", size: 10 });
  // The app's own upload route needs a v1 token, so its URL carries a signature instead.
  const url = prepared.upload.url as string;
  expect(url).toMatch(new RegExp(`^http://localhost:3003/api/v1/uploads/${id}/file\\?owner=[\\w-]+&expires=\\d+&signature=[\\w-]+$`));
  const signed = new URL(url).searchParams;
  expect(verifyUploadLink(id, signed)).toMatchObject({ userId: 'user' });
  // The link expires before the prepared upload, and the result says when.
  expect(Number(signed.get('expires'))).toBeLessThanOrEqual(now + 31 * 60 * 1000);
  expect(Date.parse(prepared.upload.expiresAt)).toBe(Number(signed.get('expires')));
  expect(prepared.curl).toBe(`curl -fsS -X PUT -H 'Content-Type: application/pdf' --data-binary @'Bob'\\''s paper.pdf' '${url}'`);
  expect((await run('openreader_docs', 'docs upload --name a.pdf')).isError).toBe(true);

  mocks.submit.mockResolvedValueOnce({ id, status: 'processing', document: null, error: null });
  expect((await run('openreader_docs', `docs add ${id.toUpperCase()} --folder f1`)).structuredContent).toMatchObject({ status: 'processing', uploadId: id, next: expect.stringContaining(`docs add ${id}`) });
  expect(mocks.submit.mock.calls[0].slice(1)).toEqual([id, 'f1']);
  mocks.submit.mockResolvedValueOnce({ id, status: 'ready', document: doc, error: null });
  expect((await run('openreader_docs', `docs add ${id}`)).structuredContent).toMatchObject({ status: 'ready', document: { id: doc.id, folderId: 'f1' } });
  expect(mocks.create).not.toHaveBeenCalled();
});

test('documents rename keeping their extension and move between folders, and folders are listed and organized', async () => {
  mocks.require.mockResolvedValue(doc);
  mocks.update.mockImplementation(async (_caller: unknown, ids: string[], patch: Record<string, unknown>) => ({ data: [{ ...doc, id: ids[0], ...patch }] }));
  expect((await run('openreader_docs', `docs rename ${doc.id} "Attention Is All You Need.txt"`)).structuredContent.document.name).toBe('Attention Is All You Need.pdf');
  expect((await run('openreader_docs', `docs rename ${doc.id} ".pdf"`)).isError).toBe(true);
  await run('openreader_docs', `docs move ${doc.id} f2`);
  await run('openreader_docs', `docs move ${doc.id} -`);
  expect(mocks.update.mock.calls.slice(1).map(call => call[2])).toEqual([{ folderId: 'f2' }, { folderId: null }]);

  mocks.list.mockResolvedValue({ data: [], nextCursor: null });
  await run('openreader', 'docs list --folder -');
  expect(mocks.list.mock.calls[0][1].toString()).toBe('limit=50&folderId=');
  mocks.folders.mockResolvedValue({ data: [{ id: 'f1', name: 'Papers', position: 1, createdAt: 1, updatedAt: 1 }], nextCursor: null });
  mocks.folders.mockResolvedValueOnce({ data: [{ id: 'f1', name: 'Papers', position: 1, createdAt: 1, updatedAt: 1 }], nextCursor: 'next' });
  expect((await run('openreader', 'folders list')).structuredContent).toEqual({ folders: [{ id: 'f1', name: 'Papers' }], nextCursor: 'next' });
  await run('openreader', 'folders list --cursor next');
  expect(mocks.folders.mock.calls[1][1].toString()).toBe('limit=200&cursor=next');
  mocks.createFolder.mockResolvedValue({ id: 'f3', name: 'Novels' });
  expect((await run('openreader_docs', 'folders create Novels')).structuredContent).toEqual({ folder: { id: 'f3', name: 'Novels' } });
  mocks.updateFolder.mockResolvedValue({ id: 'f1', name: 'Research' });
  await run('openreader_docs', 'folders rename f1 Research');
  expect(mocks.updateFolder.mock.calls[0].slice(1)).toEqual(['f1', { name: 'Research' }]);
});

test('deleting is its own tool: a document goes with its audio, and a folder keeps its documents', async () => {
  expect((await run('openreader_docs', `docs delete ${doc.id}`)).isError).toBe(true);
  mocks.require.mockResolvedValue(doc);
  mocks.remove.mockResolvedValue({ deleted: 1 });
  expect((await run('openreader_delete', `docs delete ${doc.id}`)).structuredContent).toEqual({ deleted: true, document: { id: doc.id, name: 'Paper.pdf' } });
  expect(mocks.remove.mock.calls[0][1]).toEqual([doc.id]);

  mocks.requireFolder.mockResolvedValueOnce({ id: 'f1', name: 'Papers' });
  expect((await run('openreader_delete', 'folders delete f1')).structuredContent).toEqual({ deleted: true, folder: { id: 'f1', name: 'Papers' } });
  expect(mocks.deleteFolder.mock.calls[0][1]).toBe('f1');
  const { ApiRequestError } = await import('@/lib/server/api/responses');
  mocks.requireFolder.mockRejectedValueOnce(new ApiRequestError(404, 'FOLDER_NOT_FOUND', 'Folder not found.'));
  expect((await run('openreader_delete', 'folders delete f9')).structuredContent.error.code).toBe('FOLDER_NOT_FOUND');
  expect(mocks.deleteFolder).toHaveBeenCalledTimes(1);
});

test('voice IDs carry provider and model, so a listed voice names one speech setting', async () => {
  mocks.providers.mockResolvedValue([{ id: 'fish', name: 'Fish Audio', type: 'fish-audio', defaultModel: 's2', selected: true, selectedModel: 's2', models: [{ id: 's2', name: 'S2' }] }]);
  mocks.voices.mockResolvedValue({ provider: 'fish', model: 's2', status: 'listed', nextCursor: null, data: [{ id: 'a/b', name: 'Sarah' }] });
  const listed = await run('openreader', 'voices list --provider fish');
  expect(mocks.voices.mock.calls[0][1].toString()).toBe('provider=fish');
  expect(listed.structuredContent).toEqual({ providers: [{ id: 'fish', name: 'Fish Audio', defaultModel: 's2', models: ['s2'], saved: true, savedModel: 's2' }],
    provider: 'fish', model: 's2', voices: [{ id: 'fish/s2/a%2Fb', name: 'Sarah' }] });

  mocks.start.mockImplementation(async (_caller: unknown, _intent: unknown, options: { onRequested?: (request: { created: boolean }) => void }) => {
    options.onRequested?.({ created: true });
    return audiobook;
  });
  const created = await run('openreader_audio', 'audiobook create doc --voice fish/s2/a%2Fb --model-speed 1.2 --format m4b');
  expect(mocks.intent.mock.calls[0][2]).toMatchObject({ format: 'm4b', record: { provider: 'fish', model: 's2', voice: 'a/b', modelSpeed: 1.2 } });
  expect(created.structuredContent).toMatchObject({ id: 'book', voice: 'kokoro/kokoro/af_sky', modelSpeed: 1.2, created: true, reusedCachedAudio: true });
  expect(JSON.stringify(created)).not.toMatch(/secret|op-internal/);
});

test('an unreachable provider is reported instead of guessed voices, and the other providers stay listed', async () => {
  mocks.providers.mockResolvedValue([{ id: 'fish', name: 'Fish', defaultModel: 's2', selected: false, models: [{ id: 's2' }] }]);
  mocks.voices.mockResolvedValue({ provider: 'local', model: 'kokoro', status: 'unreachable', nextCursor: null, data: [{ id: 'af_sky', name: 'Sky' }] });
  const listed = (await run('openreader', 'voices list')).structuredContent;
  expect(listed).toMatchObject({ voices: [], error: { code: 'PROVIDER_UNAVAILABLE' }, providers: [{ id: 'fish' }] });
});

test('voices cached lists reusable audio with the voice ID and model speed to ask for', async () => {
  mocks.cached.mockResolvedValue([{ provider: 'custom', model: 'KittenTTS', voice: 'Luna', name: 'Luna', modelSpeed: 1.2, segments: 2231, durationMs: 9_000_000, updatedAt: Date.UTC(2026, 8, 29) }]);
  expect((await run('openreader', 'voices cached doc')).structuredContent).toEqual({ voices: [{
    id: 'custom/KittenTTS/Luna', name: 'Luna', modelSpeed: 1.2, segments: 2231, minutes: 150, updatedAt: '2026-09-29T00:00:00.000Z' }] });
});

test('audiobooks are named by ID alone, and cancel keeps the request as cancelled', async () => {
  mocks.get.mockResolvedValueOnce({ ...audiobook, status: 'ready', webDownloadUrl: 'http://localhost:3003/audiobooks/doc/abcdef12' });
  const viewed = await run('openreader', 'audiobook view book');
  expect(mocks.get.mock.calls[0].slice(1)).toEqual(['book', 'doc']);
  // Reading never starts or resumes generation, whatever the token's scopes.
  expect(mocks.get.mock.calls[0][0]).toMatchObject({ mayGenerate: false });
  expect(viewed.structuredContent).toMatchObject({ status: 'ready', webDownloadUrl: 'http://localhost:3003/audiobooks/doc/abcdef12' });
  expect(JSON.stringify(viewed)).not.toContain('/api/v1');

  mocks.stop.mockResolvedValueOnce({ ...audiobook, status: 'cancelled' });
  expect((await run('openreader_audio', 'audiobook cancel book')).structuredContent).toMatchObject({ id: 'book', status: 'cancelled' });

  mocks.audiobooks.mockResolvedValueOnce({ data: [audiobook], nextCursor: '20' });
  expect((await run('openreader', 'audiobook list doc --cursor 20')).structuredContent).toMatchObject({ audiobooks: [{ id: 'book', voice: 'kokoro/kokoro/af_sky' }], nextCursor: '20' });
  expect(mocks.audiobooks.mock.calls[0].slice(1)).toEqual(['doc', { limit: 20, offset: 20 }]);

  mocks.owner.mockResolvedValueOnce(null);
  expect((await run('openreader', 'audiobook view missing')).structuredContent.error.code).toBe('AUDIOBOOK_NOT_FOUND');
});

test('tool failures come back as readable errors with their code', async () => {
  const { apiErrorResponse } = await import('@/lib/server/api/responses');
  mocks.intent.mockResolvedValueOnce(apiErrorResponse(409, 'DOCUMENT_PREPARING', 'This PDF is still being prepared.', { retryAfterMs: 5000 }));
  expect(await run('openreader_audio', 'audiobook create doc')).toMatchObject({ isError: true, content: [{ text: 'This PDF is still being prepared.' }],
    structuredContent: { error: { code: 'DOCUMENT_PREPARING', retryAfterMs: 5000 } } });
  mocks.worker.mockReturnValue(false);
  expect((await run('openreader', 'audiobook view book')).structuredContent.error.code).toBe('COMPUTE_WORKER_REQUIRED');
});

test('every audiobook says what to do next, with the exact command that resumes it', async () => {
  const view = async (fields: Record<string, unknown>) => {
    mocks.get.mockResolvedValueOnce({ ...audiobook, ...fields });
    return (await run('openreader', 'audiobook view book')).structuredContent;
  };
  const resume = 'audiobook create doc --voice kokoro/kokoro/af_sky --model-speed 1.2 --speed 1 --format mp3';
  expect((await view({ status: 'interrupted' })).next).toContain(resume);
  expect((await view({ status: 'cancelled', chapter: 2 })).next).toContain(`${resume} --chapter 2`);
  expect((await view({ status: 'usage_limited' })).next).toContain('quota');
  expect((await view({ status: 'generating' })).next).toContain('audiobook view book');
  expect(await view({ status: 'ready' })).toMatchObject({ next: expect.stringContaining('webDownloadUrl'), requestedAt: '2026-11-12T00:00:00.000Z' });
});

test('deleting an audiobook keeps its document, and a file being built cannot be deleted yet', async () => {
  expect((await run('openreader_audio', 'audiobook delete book')).isError).toBe(true);
  mocks.deleteBook.mockResolvedValueOnce(true);
  expect((await run('openreader_delete', 'audiobook delete book')).structuredContent).toEqual({ deleted: true, audiobook: { id: 'book', documentId: 'doc' } });
  expect(mocks.deleteBook.mock.calls[0].slice(1)).toEqual(['book', 'doc']);
  expect(mocks.remove).not.toHaveBeenCalled();

  const { AudiobookBuildingError } = await import('@/lib/server/audiobooks/audiobooks');
  mocks.deleteBook.mockRejectedValueOnce(new AudiobookBuildingError());
  expect((await run('openreader_delete', 'audiobook delete book')).structuredContent.error.code).toBe('AUDIOBOOK_BUILDING');
});
