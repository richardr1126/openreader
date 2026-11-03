import { McpServer, requireScopes, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiPrincipal, ApiScope } from '@/lib/server/api/principal';
import { ApiRequestError, apiErrorResponse } from '@/lib/server/api/responses';
import { ChapterNotFoundError, getAudiobook, startAudiobook } from '@/lib/server/audiobooks/audiobooks';
import { audiobookCaller, parseAudiobookBody, resolveAudiobookIntent } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createDocument } from '@/lib/server/documents/create';
import { documentCaller, documentRequestFailure } from '@/lib/server/documents/request';
import { documentId, documentWebUrl, listDocumentResources } from '@/lib/server/documents/resources';
import { serverLogger } from '@/lib/server/logger';
import { listSpeechProviders, listVoices } from '@/lib/server/tts/voices';
import { API_SCOPES } from '@/lib/shared/api-scopes';
import type { BaseDocument } from '@/types/documents';
import type { Audiobook } from '@/types/tts-export';

export function mcpAuthInfo(token: string, principal: ApiPrincipal, resource: string, resourceMetadataUrl: string): AuthInfo {
  return { token, clientId: principal.clientId ?? '', scopes: [...principal.scopes], resource: new URL(resource),
    resourceMetadataUrl, extra: { userId: principal.userId } };
}

function mcpPrincipal(authInfo: AuthInfo | undefined): ApiPrincipal {
  if (typeof authInfo?.extra?.userId !== 'string') throw new ApiRequestError(401, 'INVALID_TOKEN', 'A valid OAuth access token is required.');
  return { userId: authInfo.extra.userId, isAnonymous: false, clientId: authInfo.clientId,
    scopes: API_SCOPES.filter(scope => authInfo.scopes.includes(scope)) };
}

/** Links here must work when clicked, so resource URLs that need a v1 token stay out. */
function documentSummary(document: BaseDocument) {
  return { id: document.id, name: document.name, type: document.type, size: document.size, author: document.author ?? null,
    language: document.language ?? null, webUrl: documentWebUrl(document) };
}

function audiobookSummary(audiobook: Audiobook) {
  const { id, documentId: bookDocumentId, status, progress, format, speed, chapter, filename, webUrl, retryAfterMs } = audiobook;
  return { id, documentId: bookDocumentId, status, progress, format, speed, chapter, filename, webUrl, retryAfterMs,
    issue: audiobook.generation.issue ?? audiobook.artifact.issue ?? null };
}

async function failure(error: unknown): Promise<Response> {
  if (error instanceof ChapterNotFoundError) return apiErrorResponse(404, 'CHAPTER_NOT_FOUND', error.message);
  return documentRequestFailure(error, serverLogger);
}

/** A failed tool is a result the model can read and act on, in the same shape as a v1 error. */
async function toolResult(work: () => Promise<unknown>): Promise<CallToolResult> {
  const result = await work().catch(failure);
  if (result instanceof Response) {
    const { error } = await result.json() as { error: { message: string } };
    return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { error } };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
}

function requireComputeWorker() {
  if (!isComputeWorkerAvailable()) throw new ApiRequestError(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
}

const scope = (required: ApiScope) => requireScopes(required);
const id = z.string().min(1).max(128);

export function createMcpServer({ authInfo }: { authInfo?: AuthInfo }): McpServer {
  const server = new McpServer({ name: 'openreader', version: '1' }, {
    instructions: 'Add documents to the user\'s OpenReader library and turn them into audiobooks. Audiobooks generate in the background: create_audiobook returns at once, get_audiobook reports progress, and webUrl opens the document for the user.',
  });
  const run = (work: (principal: ApiPrincipal) => Promise<unknown>) => toolResult(() => Promise.resolve().then(() => work(mcpPrincipal(authInfo))));

  server.registerTool('list_documents', {
    title: 'List documents',
    description: 'List or search documents in the user\'s library.',
    inputSchema: z.object({
      query: z.string().max(512).optional().describe('Text to find in document names.'),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: id.optional().describe('nextCursor from an earlier page.'),
    }),
    annotations: { readOnlyHint: true },
    scopeChallenge: scope('documents:read'),
  }, ({ query, limit, cursor }) => run(async principal => {
    const search = new URLSearchParams({ limit: String(limit ?? 50), ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) });
    const page = await listDocumentResources(principal, search);
    return { documents: page.data.map(documentSummary), nextCursor: page.nextCursor };
  }));

  server.registerTool('add_document', {
    title: 'Add document',
    description: 'Add a web page or text to the user\'s library. Provide url or text, not both. Text is limited to 2 MB.',
    inputSchema: z.object({
      url: z.string().max(2048).optional().describe('A public web page to import.'),
      text: z.string().optional().describe('Plain text or Markdown to save.'),
      name: z.string().max(255).optional().describe('Document name. Text documents need a .txt or .md extension.'),
    }),
    annotations: { openWorldHint: true },
    scopeChallenge: scope('documents:write'),
  }, ({ url, text, name }) => run(async principal => {
    if (Boolean(url) === Boolean(text)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provide url or text, not both.');
    const source = url ? { type: 'url', url } : { type: 'text', text };
    const upload = await createDocument(documentCaller(principal), { source, ...(name ? { name } : {}) });
    return upload.document
      ? { status: upload.status, document: documentSummary(upload.document) }
      : { status: upload.status, error: upload.error };
  }));

  server.registerTool('list_providers', {
    title: 'List speech providers',
    description: 'List the speech providers the user can use, with their models, and which one is saved in their settings.',
    annotations: { readOnlyHint: true },
    scopeChallenge: scope('documents:read'),
  }, () => run(async principal => ({ providers: await listSpeechProviders(principal) })));

  server.registerTool('list_voices', {
    title: 'List voices',
    description: 'List voices, with their IDs and names, for a provider and model you name, or for the user\'s saved ones. Includes the user\'s own cloned voices.',
    inputSchema: z.object({
      provider: z.string().max(200).optional().describe('A provider ID from list_providers.'),
      model: z.string().max(512).optional().describe('A model ID from list_providers.'),
    }),
    annotations: { readOnlyHint: true },
    scopeChallenge: scope('documents:read'),
  }, ({ provider, model }) => run(principal => listVoices(principal, new URLSearchParams({
    ...(provider ? { provider } : {}), ...(model ? { model } : {}),
  }))));

  server.registerTool('create_audiobook', {
    title: 'Create audiobook',
    description: 'Start an audiobook of a document, or one chapter of it, using any provider and voice the user can use, or their saved speech settings if you name none. Returns at once with a status; the same request returns the same audiobook. Use get_audiobook to check progress.',
    inputSchema: z.object({
      documentId: id,
      provider: z.string().max(200).optional().describe('A provider ID from list_providers. Defaults to the user\'s saved provider.'),
      model: z.string().max(512).optional().describe('A model ID from list_providers. Defaults to the saved model, or to the default model of the provider you name.'),
      voice: z.string().max(512).optional().describe('A voice ID from list_voices for that provider and model. Defaults to the user\'s saved voice, or to the first voice of the provider you name.'),
      format: z.enum(['mp3', 'm4b']).optional(),
      speed: z.number().min(0.5).max(3).optional(),
      chapter: z.number().int().min(0).optional().describe('Zero-based chapter. Omit for the whole document.'),
    }),
    annotations: { idempotentHint: true },
    scopeChallenge: scope('audio:generate'),
  }, ({ documentId: requested, ...options }) => run(async principal => {
    requireComputeWorker();
    const bookId = documentId(requested);
    const body = parseAudiobookBody(options);
    if (body instanceof Response) return body;
    const caller = await audiobookCaller(principal, bookId);
    if (caller instanceof Response) return caller;
    const intent = await resolveAudiobookIntent(caller, bookId, body);
    if (intent instanceof Response) return intent;
    const { providerRef, ttsModel, voice } = intent.parsed.settings;
    return { ...audiobookSummary(await startAudiobook(caller, intent, { retrySkipped: false, includeProgress: true })),
      provider: providerRef, model: ttsModel, voice };
  }));

  server.registerTool('get_audiobook', {
    title: 'Get audiobook',
    description: 'Check an audiobook\'s status and progress.',
    inputSchema: z.object({ documentId: id, audiobookId: id }),
    annotations: { readOnlyHint: true },
    scopeChallenge: scope('documents:read'),
  }, ({ documentId: requested, audiobookId }) => run(async principal => {
    requireComputeWorker();
    const bookId = documentId(requested);
    const caller = await audiobookCaller(principal, bookId);
    if (caller instanceof Response) return caller;
    const audiobook = await getAudiobook(caller, audiobookId, bookId);
    if (!audiobook) throw new ApiRequestError(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found.');
    return audiobookSummary(audiobook);
  }));

  return server;
}
