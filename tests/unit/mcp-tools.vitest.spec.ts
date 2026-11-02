import { NextRequest } from 'next/server';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), create: vi.fn(), voices: vi.fn(), start: vi.fn(), get: vi.fn(), caller: vi.fn(), intent: vi.fn(), worker: vi.fn(() => true),
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
  documentId: (value: string) => value, documentWebUrl: (document: { id: string }) => `http://localhost:3003/html/${document.id}`, listDocumentResources: vi.fn(),
}));
vi.mock('@/lib/server/tts/voices', () => ({ listVoices: mocks.voices }));
vi.mock('@/lib/server/audiobooks/audiobooks', () => ({ ChapterNotFoundError: class extends Error {}, getAudiobook: mocks.get, startAudiobook: mocks.start }));
vi.mock('@/lib/server/audiobooks/request', async () => ({ audiobookCaller: mocks.caller, resolveAudiobookIntent: mocks.intent,
  parseAudiobookBody: (record: Record<string, unknown>) => ({ record, format: record.format ?? 'mp3', speed: record.speed ?? 1, chapterIndex: record.chapter ?? null }) }));
vi.mock('@/lib/server/compute-worker/client', () => ({ isComputeWorkerAvailable: mocks.worker, isComputeWorkerUnavailableError: () => false }));

const audiobook = { id: 'book', documentId: 'doc', status: 'generating', progress: 0.5, format: 'mp3', speed: 1, chapter: null,
  downloadUrl: '/api/v1/documents/doc/audiobooks/files/secret', filename: null, webUrl: 'http://localhost:3003/html/doc', retryAfterMs: null,
  generation: { state: 'generating', operationId: 'op-internal', issue: null }, segments: null, artifact: { state: 'none', operationId: null, issue: null } };

async function callTool(name: string, args: Record<string, unknown>) {
  const { POST } = await import('@/app/api/mcp/route');
  const response = await POST(new NextRequest('http://localhost:3003/api/mcp', { method: 'POST', headers: {
    authorization: 'Bearer token', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  expect(response.status).toBe(200);
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : /^data: (.+)$/m.exec(text)![1]).result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.worker.mockReturnValue(true);
  mocks.access.mockResolvedValue({ userId: 'user', isAnonymous: false, clientId: 'client', scopes: ['documents:read', 'documents:write', 'audio:generate'] });
  mocks.caller.mockResolvedValue({ scope: {} });
  mocks.intent.mockResolvedValue({ parsed: {} });
});

test('add_document imports a URL or text and returns a clickable link, not a v1 resource URL', async () => {
  mocks.create.mockResolvedValue({ id: 'upload', status: 'ready', statusUrl: '/api/v1/uploads/upload', document: { id: 'doc', name: 'page.md', type: 'html', size: 3, fileUrl: '/api/v1/documents/doc/file', webUrl: 'x' } });
  const result = await callTool('add_document', { url: 'https://example.com/page' });
  expect(mocks.create.mock.calls[0][1]).toEqual({ source: { type: 'url', url: 'https://example.com/page' } });
  expect(result.structuredContent).toEqual({ status: 'ready', document: { id: 'doc', name: 'page.md', type: 'html', size: 3, author: null, language: null, webUrl: 'http://localhost:3003/html/doc' } });
  expect(JSON.stringify(result)).not.toContain('/api/v1');
  expect((await callTool('add_document', { url: 'https://example.com', text: 'both' })).isError).toBe(true);
  expect((await callTool('add_document', {})).isError).toBe(true);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

test('create_audiobook returns a status at once, with no download link or internal operation', async () => {
  mocks.start.mockResolvedValue(audiobook);
  const result = await callTool('create_audiobook', { documentId: 'doc', voice: 'af_sky', format: 'm4b' });
  expect(mocks.intent.mock.calls[0][2]).toMatchObject({ format: 'm4b', record: { voice: 'af_sky' } });
  expect(result.structuredContent).toEqual({ id: 'book', documentId: 'doc', status: 'generating', progress: 0.5, format: 'mp3', speed: 1, chapter: null, filename: null,
    webUrl: 'http://localhost:3003/html/doc', retryAfterMs: null, issue: null });
  expect(JSON.stringify(result)).not.toMatch(/secret|op-internal/);
});

test('tool failures come back as readable errors with their code', async () => {
  const { ApiRequestError, apiErrorResponse } = await import('@/lib/server/api/responses');
  mocks.intent.mockResolvedValueOnce(apiErrorResponse(409, 'DOCUMENT_PREPARING', 'This PDF is still being prepared.', { retryAfterMs: 5000 }));
  expect(await callTool('create_audiobook', { documentId: 'doc' })).toMatchObject({ isError: true, content: [{ text: 'This PDF is still being prepared.' }],
    structuredContent: { error: { code: 'DOCUMENT_PREPARING', retryAfterMs: 5000 } } });
  mocks.get.mockResolvedValueOnce(null);
  expect((await callTool('get_audiobook', { documentId: 'doc', audiobookId: 'missing' })).structuredContent.error.code).toBe('AUDIOBOOK_NOT_FOUND');
  mocks.voices.mockRejectedValueOnce(new ApiRequestError(503, 'PROVIDER_UNAVAILABLE', 'The selected speech provider is unavailable.'));
  expect((await callTool('list_voices', {})).structuredContent.error.code).toBe('PROVIDER_UNAVAILABLE');
  mocks.worker.mockReturnValue(false);
  expect((await callTool('get_audiobook', { documentId: 'doc', audiobookId: 'book' })).structuredContent.error.code).toBe('COMPUTE_WORKER_REQUIRED');
});

test('invalid arguments are rejected before any work starts', async () => {
  expect((await callTool('create_audiobook', { documentId: 'doc', speed: 9 })).isError).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
});
