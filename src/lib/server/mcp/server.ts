import { McpServer, requireScopes, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiPrincipal, ApiScope } from '@/lib/server/api/principal';
import { ApiRequestError, apiErrorResponse } from '@/lib/server/api/responses';
import {
  ChapterCommandError,
  ChapterNotFoundError,
  findAudiobookDocumentId,
  getAudiobook,
  listAudiobookRequests,
  startAudiobook,
  stopAudiobook,
} from '@/lib/server/audiobooks/audiobooks';
import { audiobookCaller, parseAudiobookBody, resolveAudiobookIntent } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createDocument } from '@/lib/server/documents/create';
import { documentCaller, documentRequestFailure } from '@/lib/server/documents/request';
import { describeDocument, documentId, documentWebUrl, listDocumentResources, removeDocuments, requireDocument, updateDocuments } from '@/lib/server/documents/resources';
import { signUploadLink } from '@/lib/server/documents/upload-links';
import { prepareDocumentUpload, submitDocumentUpload, uploadId } from '@/lib/server/documents/uploads';
import { createFolder, deleteFolder, folderId, listFolders, requireFolder, updateFolder } from '@/lib/server/folders';
import { serverLogger } from '@/lib/server/logger';
import { listCachedVoices } from '@/lib/server/tts/cached-voices';
import { listSpeechProviders, listVoices } from '@/lib/server/tts/voices';
import { API_SCOPES } from '@/lib/shared/api-scopes';
import type { BaseDocument } from '@/types/documents';
import type { DocumentUploadResource } from '@/types/document-api';
import type { Audiobook } from '@/types/tts-export';
import { CliUsageError, helpText, parseCommand, type CliCommand } from './cli';

export function mcpAuthInfo(token: string, principal: ApiPrincipal, resource: string, resourceMetadataUrl: string): AuthInfo {
  return { token, clientId: principal.clientId ?? '', scopes: [...principal.scopes], resource: new URL(resource),
    resourceMetadataUrl, extra: { userId: principal.userId } };
}

function mcpPrincipal(authInfo: AuthInfo | undefined): ApiPrincipal {
  if (typeof authInfo?.extra?.userId !== 'string') throw new ApiRequestError(401, 'INVALID_TOKEN', 'A valid OAuth access token is required.');
  return { userId: authInfo.extra.userId, isAnonymous: false, clientId: authInfo.clientId,
    scopes: API_SCOPES.filter(scope => authInfo.scopes.includes(scope)) };
}

/**
 * One voice ID carries its provider and model, so a voice from `voices list` or
 * `voices cached` names exactly one speech setting. Each part is URI-encoded,
 * because provider-native voice IDs may contain a slash.
 */
export function voiceId(provider: string, model: string, voice: string): string {
  return [provider, model, voice].map(encodeURIComponent).join('/');
}

function parseVoiceId(value: string): { provider?: string; model?: string; voice: string } {
  const parts = value.split('/');
  if (parts.length === 1) return { voice: value };
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw new CliUsageError('--voice takes an ID from "voices list" or "voices cached", in the form provider/model/voice.');
  }
  try {
    const [provider, model, voice] = parts.map(decodeURIComponent);
    return { provider, model, voice };
  } catch {
    throw new CliUsageError('--voice is not a valid voice ID.');
  }
}

/** Links here must work when clicked, so resource URLs that need a v1 token stay out. */
function documentSummary(document: BaseDocument) {
  return { id: document.id, name: document.name, type: document.type, size: document.size, author: document.author ?? null,
    language: document.language ?? null, folderId: document.folderId ?? null, webUrl: documentWebUrl(document) };
}

const appUrl = (path: string) => new URL(path, (process.env.BASE_URL ?? '').trim() || 'http://localhost').toString();

/** The signed-in library page that opens the file picker, into a folder when one is named. */
const uploadPageUrl = (folder?: string) => appUrl(folder ? `/app/upload/${encodeURIComponent(folder)}` : '/app/upload');

/** `-` names the top of the library; anything else is a folder ID. */
const folderArg = (value: string) => (value === '-' ? null : folderId(value));

const AUDIOBOOK_PAGE = 20;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_EXTENSION = /\.(pdf|epub|docx|txt|md|markdown|mdown|mkd|html?)$/i;

function uploadResult(upload: DocumentUploadResource) {
  if (upload.document) return { status: upload.status, document: documentSummary(upload.document) };
  return { status: upload.status, uploadId: upload.id, error: upload.error,
    ...(upload.status === 'processing' ? { next: `The document is still being converted. Run "docs add ${upload.id}" again to finish adding it.` } : {}),
    ...(upload.status === 'pending' ? { next: `Nothing has been sent to this upload yet. Send the file, then run "docs add ${upload.id}".` } : {}) };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function audiobookSummary(audiobook: Audiobook) {
  const { id, documentId: bookDocumentId, status, progress, format, speed, chapter, filename, webUrl, webDownloadUrl, retryAfterMs } = audiobook;
  return { id, documentId: bookDocumentId, status, progress, format, speed, chapter, filename, webUrl, webDownloadUrl, retryAfterMs,
    issue: audiobook.generation.issue ?? audiobook.artifact.issue ?? null };
}

function requireComputeWorker() {
  if (!isComputeWorkerAvailable()) throw new ApiRequestError(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
}

async function audiobookOwner(principal: ApiPrincipal, bookDocumentId: string) {
  requireComputeWorker();
  const caller = await audiobookCaller(principal, bookDocumentId);
  if (caller instanceof Response) throw caller;
  return caller;
}

async function requireAudiobookDocument(principal: ApiPrincipal, audiobookId: string) {
  const bookDocumentId = await findAudiobookDocumentId(audiobookId, principal.userId);
  if (!bookDocumentId) throw new ApiRequestError(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found. "audiobook list <doc>" shows a document\'s audiobooks.');
  return bookDocumentId;
}

const minutes = (durationMs: number) => Math.round(durationMs / 6_000) / 10;

type Context = { principal: ApiPrincipal; input?: string };

const readCommands: CliCommand<Context>[] = [
  {
    name: ['docs', 'list'],
    summary: 'List documents in the library, newest first.',
    flags: {
      search: { type: 'string', description: 'Text to find in document names.' },
      limit: { type: 'integer', description: 'How many to list, 1 to 200. Default 50.' },
      cursor: { type: 'string', description: 'nextCursor from an earlier page.' },
      folder: { type: 'string', description: 'Only documents in this folder, or "-" for those in no folder.' },
    },
    run: async ({ flags }, { principal }) => {
      const folder = flags.folder === undefined ? undefined : folderArg(String(flags.folder));
      const search = new URLSearchParams({ limit: String(flags.limit ?? 50),
        ...(flags.search ? { q: String(flags.search) } : {}), ...(flags.cursor ? { cursor: String(flags.cursor) } : {}),
        ...(folder !== undefined ? { folderId: folder ?? '' } : {}) });
      const page = await listDocumentResources(principal, search);
      return { documents: page.data.map(documentSummary), nextCursor: page.nextCursor };
    },
  },
  {
    name: ['docs', 'view'],
    args: ['doc'],
    summary: 'Show one document and whether it is ready to read.',
    run: async ({ args }, { principal }) => {
      const document = await describeDocument(await requireDocument(principal, args.doc));
      return { ...documentSummary(document), status: document.status, error: document.error };
    },
  },
  {
    name: ['folders', 'list'],
    summary: 'List the folders in the library, in their sidebar order.',
    flags: { cursor: { type: 'string', description: 'nextCursor from an earlier page.' } },
    run: async ({ flags }, { principal }) => {
      const folders = await listFolders(principal, new URLSearchParams({ limit: '200', ...(flags.cursor ? { cursor: String(flags.cursor) } : {}) }));
      return { folders: folders.data.map(({ id, name }) => ({ id, name })), nextCursor: folders.nextCursor };
    },
  },
  {
    name: ['voices', 'list'],
    summary: 'List speech providers and their models, then the voices of one provider and model: the saved ones unless you name others.',
    flags: {
      provider: { type: 'string', description: 'A provider ID from this list.' },
      model: { type: 'string', description: 'A model ID of that provider. Default: its default model.' },
    },
    run: async ({ flags }, { principal }) => {
      const [providers, voices] = await Promise.all([
        listSpeechProviders(principal),
        listVoices(principal, new URLSearchParams({
          ...(flags.provider ? { provider: String(flags.provider) } : {}), ...(flags.model ? { model: String(flags.model) } : {}),
        })),
      ]);
      const unreachable = voices.status === 'unreachable';
      return {
        providers: providers.map(({ id, name, defaultModel, selected, selectedModel, models }) => ({
          id, name, defaultModel, models: models.map(model => model.id), ...(selected ? { saved: true, savedModel: selectedModel } : {}),
        })),
        provider: voices.provider,
        model: voices.model,
        // Unconfirmed voices are left out; the providers above stay listed so another can be chosen.
        voices: unreachable ? [] : voices.data.map(voice => ({ id: voiceId(voices.provider, voices.model, voice.id), name: voice.name })),
        ...(unreachable ? { error: { code: 'PROVIDER_UNAVAILABLE', message: `The speech provider "${voices.provider}" can't be reached, so its voices can't be listed. Try again once it is back, or use another provider.` } } : {}),
      };
    },
  },
  {
    name: ['voices', 'cached'],
    args: ['doc'],
    summary: 'List the voices this document already has audio for. Creating an audiobook with one of them, and its model speed, reuses that audio.',
    run: async ({ args }, { principal }) => {
      const bookDocumentId = documentId(args.doc);
      const voices = await listCachedVoices(await audiobookOwner(principal, bookDocumentId), bookDocumentId);
      if (voices instanceof Response) throw voices;
      return { voices: voices.map(voice => ({
        id: voiceId(voice.provider, voice.model, voice.voice), name: voice.name, modelSpeed: voice.modelSpeed,
        segments: voice.segments, minutes: minutes(voice.durationMs), updatedAt: new Date(voice.updatedAt).toISOString(),
      })) };
    },
  },
  {
    name: ['audiobook', 'list'],
    args: ['doc'],
    summary: 'List the audiobooks requested for a document, newest first.',
    flags: { cursor: { type: 'string', description: 'nextCursor from an earlier page.' } },
    run: async ({ args, flags }, { principal }) => {
      const bookDocumentId = documentId(args.doc);
      const caller = await audiobookOwner(principal, bookDocumentId);
      const offset = flags.cursor === undefined ? 0 : Number(flags.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CliUsageError('--cursor must be a nextCursor from an earlier page.');
      const requests = await listAudiobookRequests(principal.userId, bookDocumentId, AUDIOBOOK_PAGE + 1, offset);
      const audiobooks = [];
      for (const { id } of requests.slice(0, AUDIOBOOK_PAGE)) {
        try {
          const audiobook = await getAudiobook(caller, id, bookDocumentId);
          if (audiobook) audiobooks.push(audiobookSummary(audiobook));
        } catch (error) {
          // A chapter that is no longer in the book leaves its request behind; list the rest.
          if (!(error instanceof ChapterNotFoundError)) throw error;
        }
      }
      return { audiobooks, nextCursor: requests.length > AUDIOBOOK_PAGE ? String(offset + AUDIOBOOK_PAGE) : null };
    },
  },
  {
    name: ['audiobook', 'view'],
    args: ['id'],
    summary: 'Show an audiobook\'s status and progress, and its download link once it is ready.',
    run: async ({ args }, { principal }) => {
      const bookDocumentId = await requireAudiobookDocument(principal, args.id);
      const audiobook = await getAudiobook(await audiobookOwner(principal, bookDocumentId), args.id, bookDocumentId);
      if (!audiobook) throw new ApiRequestError(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found.');
      return audiobookSummary(audiobook);
    },
  },
];

const docsCommands: CliCommand<Context>[] = [
  {
    name: ['docs', 'add'],
    args: ['source'],
    summary: 'Add a document from a public URL, "-" to save the text sent in input, or an upload ID from "docs upload" once its file is sent. A link to a PDF, EPUB, DOCX, Markdown or text file keeps that file, up to this instance\'s upload limit; a web page becomes Markdown, and text is limited to 2 MB.',
    flags: {
      name: { type: 'string', description: 'Document name. Text documents need a .txt or .md extension; a linked file keeps its own.' },
      folder: { type: 'string', description: 'ID of the folder to add it to.' },
    },
    run: async ({ args, flags }, { principal, input }) => {
      const caller = documentCaller(principal);
      const folder = flags.folder ? { folderId: folderId(String(flags.folder)) } : {};
      if (UPLOAD_ID.test(args.source)) {
        if (flags.name) throw new CliUsageError('An upload keeps the name it was prepared with. Rename the document once it is added.');
        return uploadResult(await submitDocumentUpload(caller, uploadId(args.source), folder.folderId));
      }
      let source: Record<string, string>;
      if (args.source === '-') {
        if (!input) throw new CliUsageError('"docs add -" saves the text in input, and input is empty.');
        source = { type: 'text', text: input };
      } else if (/^https?:\/\//i.test(args.source)) {
        source = { type: 'url', url: args.source };
      } else {
        throw new CliUsageError('<source> must be an http(s) URL, "-" with the text in input, or an upload ID from "docs upload".');
      }
      return uploadResult(await createDocument(caller, { source, ...(flags.name ? { name: String(flags.name) } : {}), ...folder }));
    },
  },
  {
    name: ['docs', 'upload'],
    summary: 'Get a link where the user can upload a file from their device. With --name and --size, also prepare a one-time upload URL that a shell can send the file to; then run "docs add <uploadId>".',
    flags: {
      name: { type: 'string', description: 'File name with its extension: .pdf, .epub, .docx, .txt or .md.' },
      size: { type: 'integer', description: 'File size in bytes.' },
      folder: { type: 'string', description: 'ID of the folder to add it to.' },
    },
    run: async ({ flags }, { principal }) => {
      const folder = flags.folder ? folderId(String(flags.folder)) : undefined;
      const page = { uploadPageUrl: uploadPageUrl(folder) };
      if (flags.name === undefined && flags.size === undefined) {
        return { ...page, next: 'Give the user uploadPageUrl. It opens their OpenReader library with the file picker.' };
      }
      if (flags.name === undefined || flags.size === undefined) throw new CliUsageError('A one-time upload URL needs both --name and --size.');
      const prepared = await prepareDocumentUpload(documentCaller(principal), { name: String(flags.name), size: flags.size });
      // A storage URL is presigned already. The app's own upload route needs a v1
      // token, which an MCP client does not have, so its URL carries a signature.
      let url = appUrl(prepared.url);
      let expiresAt = prepared.expiresAt;
      if (url.startsWith(appUrl('/api/v1/uploads/'))) {
        const link = signUploadLink(principal.userId, prepared.id);
        url = `${url}?${link.query}`;
        expiresAt = Math.min(expiresAt, link.expiresAt);
      }
      const headers = Object.entries(prepared.headers).map(([key, value]) => `-H ${shellQuote(`${key}: ${value}`)}`).join(' ');
      return {
        ...page,
        uploadId: prepared.id,
        upload: { method: 'PUT', url, headers: prepared.headers, expiresAt: new Date(expiresAt).toISOString() },
        curl: `curl -fsS -X PUT ${headers} --data-binary @${shellQuote(String(flags.name))} ${shellQuote(url)}`,
        next: `Send the file's bytes exactly as they are, then run "docs add ${prepared.id}"${folder ? ` --folder ${folder}` : ''}. Without a shell, give the user uploadPageUrl instead.`,
      };
    },
  },
  {
    name: ['docs', 'rename'],
    args: ['doc', 'name'],
    summary: 'Rename a document. It keeps its file extension.',
    run: async ({ args }, { principal }) => {
      const current = await requireDocument(principal, args.doc);
      const base = args.name.trim().replace(DOCUMENT_EXTENSION, '').trim();
      if (!base) throw new CliUsageError('<name> must not be empty.');
      const name = `${base}${current.name.match(DOCUMENT_EXTENSION)?.[0] ?? ''}`;
      const { data } = await updateDocuments(documentCaller(principal), [current.id], { name });
      return { document: documentSummary(data[0]) };
    },
  },
  {
    name: ['docs', 'move'],
    args: ['doc', 'folder'],
    summary: 'Move a document into a folder, or "-" to take it out of its folder.',
    run: async ({ args }, { principal }) => {
      const { data } = await updateDocuments(documentCaller(principal), [args.doc], { folderId: folderArg(args.folder) });
      return { document: documentSummary(data[0]) };
    },
  },
  {
    name: ['folders', 'create'],
    args: ['name'],
    summary: 'Create a folder.',
    run: async ({ args }, { principal }) => {
      const { id, name } = await createFolder(principal, { name: args.name });
      return { folder: { id, name } };
    },
  },
  {
    name: ['folders', 'rename'],
    args: ['folder', 'name'],
    summary: 'Rename a folder.',
    run: async ({ args }, { principal }) => {
      const { id, name } = await updateFolder(principal, folderId(args.folder), { name: args.name });
      return { folder: { id, name } };
    },
  },
];

const deleteCommands: CliCommand<Context>[] = [
  {
    name: ['docs', 'delete'],
    args: ['doc'],
    summary: 'Delete a document for good, with its generated audio and audiobooks. It cannot be undone.',
    run: async ({ args }, { principal }) => {
      const document = await requireDocument(principal, args.doc);
      const { deleted } = await removeDocuments(documentCaller(principal), [document.id]);
      return { deleted: deleted === 1, document: { id: document.id, name: document.name } };
    },
  },
  {
    name: ['folders', 'delete'],
    args: ['folder'],
    summary: 'Delete a folder. Its documents are kept and move to the top of the library.',
    run: async ({ args }, { principal }) => {
      const { id, name } = await requireFolder(principal, args.folder);
      await deleteFolder(principal, id);
      return { deleted: true, folder: { id, name } };
    },
  },
];

const audioCommands: CliCommand<Context>[] = [
  {
    name: ['audiobook', 'create'],
    args: ['doc'],
    summary: 'Start an audiobook of a document, or of one chapter, in the background. It uses the saved speech settings unless you name a voice. The same request returns the same audiobook.',
    flags: {
      voice: { type: 'string', description: 'A voice ID from "voices list" or "voices cached". Default: the saved voice.' },
      'model-speed': { type: 'number', description: 'Speaking rate the model generates at, 0.5 to 3, where the model has one. It changes the audio, so it must match a cached voice to reuse it. Default: the saved speed.' },
      speed: { type: 'number', description: 'Playback speed of the finished file, 0.5 to 3. It reuses generated audio. Default 1.' },
      chapter: { type: 'integer', description: 'Zero-based chapter. Default: the whole document.' },
      format: { type: 'string', description: 'mp3 or m4b. Default mp3.' },
    },
    run: async ({ args, flags }, { principal }) => {
      const bookDocumentId = documentId(args.doc);
      const voice = typeof flags.voice === 'string' ? parseVoiceId(flags.voice) : {};
      const body = parseAudiobookBody({
        ...voice,
        ...(flags['model-speed'] !== undefined ? { modelSpeed: flags['model-speed'] } : {}),
        ...(flags.speed !== undefined ? { speed: flags.speed } : {}),
        ...(flags.chapter !== undefined ? { chapter: flags.chapter } : {}),
        ...(flags.format !== undefined ? { format: flags.format } : {}),
      });
      if (body instanceof Response) throw body;
      const caller = await audiobookOwner(principal, bookDocumentId);
      const intent = await resolveAudiobookIntent(caller, bookDocumentId, body);
      if (intent instanceof Response) throw intent;
      const audiobook = await startAudiobook(caller, intent, { retrySkipped: false, includeProgress: true });
      const { providerRef, ttsModel, voice: voiceName, nativeSpeed } = intent.parsed.settings;
      const cachedSegments = audiobook.segments?.completedSegments ?? 0;
      return {
        ...audiobookSummary(audiobook),
        voice: voiceId(providerRef, ttsModel, voiceName),
        modelSpeed: nativeSpeed,
        reusedCachedAudio: cachedSegments > 0,
      };
    },
  },
  {
    name: ['audiobook', 'cancel'],
    args: ['id'],
    summary: 'Stop a whole-book audiobook. Audio generated so far stays cached, and creating it again resumes it.',
    run: async ({ args }, { principal }) => {
      const bookDocumentId = await requireAudiobookDocument(principal, args.id);
      const audiobook = await stopAudiobook(await audiobookOwner(principal, bookDocumentId), args.id, bookDocumentId);
      if (!audiobook) throw new ApiRequestError(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found.');
      return audiobookSummary(audiobook);
    },
  },
];

async function failure(error: unknown): Promise<CallToolResult> {
  if (error instanceof CliUsageError) return { isError: true, content: [{ type: 'text', text: error.message }] };
  const response = error instanceof Response ? error
    : error instanceof ChapterNotFoundError ? apiErrorResponse(404, 'CHAPTER_NOT_FOUND', error.message)
      : error instanceof ChapterCommandError ? apiErrorResponse(409, 'CHAPTER_COMMAND', error.message)
        : await documentRequestFailure(error, serverLogger);
  const { error: body } = await response.json() as { error: { code: string; message: string } };
  return { isError: true, content: [{ type: 'text', text: body.message }], structuredContent: { error: body } };
}

/** Runs one command line. Output is JSON, and a failure is a message the model can act on. */
async function runCommand(tool: string, commands: CliCommand<Context>[], line: string, context: () => Context): Promise<CallToolResult> {
  try {
    const parsed = parseCommand(tool, commands, line);
    if ('help' in parsed) return { content: [{ type: 'text', text: parsed.help }] };
    const result = await parsed.command.run(parsed, context());
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  } catch (error) {
    return failure(error);
  }
}

const command = z.string().max(4096).describe('The command line, such as "docs list --search dune". Run "help" for every command.');

function describe(summary: string, tool: string, commands: CliCommand<Context>[]): string {
  return `${summary} Commands:\n${helpText(tool, commands)}`;
}

export function createMcpServer({ authInfo }: { authInfo?: AuthInfo }): McpServer {
  const server = new McpServer({ name: 'openreader', version: '1' }, {
    instructions: [
      'OpenReader turns documents in the user\'s library into audiobooks. Its tools take gh-style command lines: openreader reads, openreader_docs adds and organizes documents and folders, openreader_docs_delete deletes them, and openreader_audio generates audio. Output is JSON.',
      'To add a file from the user\'s device, run "docs upload". Give the user its uploadPageUrl, or, with a shell, send the file to the one-time upload URL it prepares and then run "docs add <uploadId>".',
      'Before creating an audiobook, run "voices cached <doc>": a voice listed there, with its modelSpeed, reuses audio already generated for the book. Otherwise "audiobook create" uses the saved speech settings, or a voice ID from "voices list".',
      'Audiobooks generate in the background: "audiobook create" returns at once and "audiobook view <id>" reports progress. webUrl opens the document for the user, and webDownloadUrl, once the audiobook is ready, starts its download. Give the user these links as they are.',
    ].join('\n'),
  });
  const context = (input?: string) => () => ({ principal: mcpPrincipal(authInfo), input });
  const scope = (required: ApiScope) => requireScopes(required);

  server.registerTool('openreader', {
    title: 'OpenReader',
    description: describe('Read the user\'s OpenReader library, voices and audiobooks.', 'openreader', readCommands),
    inputSchema: z.object({ command }),
    annotations: { readOnlyHint: true },
    scopeChallenge: scope('documents:read'),
  }, ({ command: line }) => runCommand('openreader', readCommands, line, context()));

  server.registerTool('openreader_docs', {
    title: 'OpenReader documents',
    description: describe('Add, rename and move documents in the user\'s OpenReader library, and organize its folders.', 'openreader_docs', docsCommands),
    inputSchema: z.object({
      command,
      input: z.string().optional().describe('Text for "docs add -": plain text or Markdown.'),
    }),
    // Adding fetches public links; none of these commands removes anything.
    annotations: { openWorldHint: true, destructiveHint: false },
    scopeChallenge: scope('documents:write'),
  }, ({ command: line, input }) => runCommand('openreader_docs', docsCommands, line, context(input)));

  server.registerTool('openreader_docs_delete', {
    title: 'OpenReader delete',
    description: describe('Delete documents or folders from the user\'s OpenReader library. Confirm with the user first: a deleted document cannot be recovered.', 'openreader_docs_delete', deleteCommands),
    inputSchema: z.object({ command }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scopeChallenge: scope('documents:write'),
  }, ({ command: line }) => runCommand('openreader_docs_delete', deleteCommands, line, context()));

  server.registerTool('openreader_audio', {
    title: 'OpenReader audio',
    description: describe('Generate and cancel audiobooks. Generation uses the user\'s speech quota.', 'openreader_audio', audioCommands),
    inputSchema: z.object({ command }),
    // Cancelling keeps the generated audio, and creating again resumes it.
    annotations: { idempotentHint: true, destructiveHint: false },
    scopeChallenge: scope('audio:generate'),
  }, ({ command: line }) => runCommand('openreader_audio', audioCommands, line, context()));

  return server;
}
