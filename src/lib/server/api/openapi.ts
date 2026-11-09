import { BRACKETED_TEXT_MODES } from '@openreader/tts/speech-text';
import { PARSED_PDF_BLOCK_KINDS } from '@/types/parsed-pdf';
import { API_SCOPE_LABELS } from '@/lib/shared/api-scopes';

type Schema = Record<string, unknown>;
const string = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema) => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const json = (schema: Schema) => ({ 'application/json': { schema } });
const response = (description: string, schema: Schema) => ({ description, content: json(schema) });
const body = (schema: Schema) => ({ required: true, content: json(schema) });
const parameter = (name: string, location: 'path' | 'query', schema: Schema = string, required = location === 'path', description?: string) =>
  ({ name, in: location, required, schema, ...(description ? { description } : {}) });
const docId = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const folderId = { type: 'string', pattern: '^[a-zA-Z0-9-]{1,100}$' };
const ids = { ...array(docId), minItems: 1, maxItems: 200 };
const paging = [parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 200, default: 100 }), parameter('cursor', 'query')];
const issue = object({ code: nullableString, message: nullableString });
const generationStates = ['idle', 'preparing', 'queued', 'generating', 'complete', 'stopped', 'usage_limited', 'interrupted', 'failed'];
const artifactStates = ['none', 'building', 'waiting', 'ready', 'stale', 'failed'];
const chapterProgress = object({ index: integer, title: string, spineHref: nullableString, page: { type: ['integer', 'null'] },
  plannedSegments: integer, completedSegments: integer, skippedSegments: integer, generatingSegments: integer, durationMs: number });
const segmentProgress = object({ plannedSegments: integer, completedSegments: integer, skippedSegments: integer,
  lastSkipIssue: { anyOf: [issue, { type: 'null' }] }, chapters: array(chapterProgress) });
const noContent = { description: 'Completed; no response body.' };
const errorResponse = response('Request failed. Inspect error.code and error.message.', ref('Error'));
const limitedResponse = { ...errorResponse, description: 'Compute admission or usage is limited.',
  headers: { 'Retry-After': { description: 'Seconds until retry.', schema: { type: 'integer', minimum: 1 } } } };
function operation(operationId: string, summary: string, scope: string | null, responses: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { operationId, summary, ...(scope ? { 'x-required-scope': scope } : {}),
    security: scope ? [{ sessionCookie: [] }, { secureSessionCookie: [] }, { oauth: [scope] }] : [],
    responses: { ...responses, ...(scope ? { default: errorResponse, '429': limitedResponse } : {}) }, ...extra };
}
const fileResponse = { description: 'File bytes in proxy mode, always sent as an attachment.', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } };
const redirectResponse = { description: 'Follow the short-lived signed storage URL; never persist it.', headers: { Location: { schema: { type: 'string', format: 'uri' } } } };
const eventsResponse = { description: 'SSE snapshot frames from the authorized operation. Reconnect after disconnect; streams are bounded to 300 seconds.',
  content: { 'text/event-stream': { schema: { type: 'string' } } } };
const audiobookBody = object({ provider: { ...string, maxLength: 200, description: 'Shared provider slug. Omit to use the saved provider.' },
  model: { ...string, maxLength: 512, description: 'Model ID. Omit to use the saved model, or the default model of the named provider.' },
  voice: { ...string, description: 'Voice ID within that provider and model. Omit to use the saved voice, or the first voice of the named provider. A named voice must be one the provider lists.' },
  modelSpeed: { type: 'number', minimum: 0.5, maximum: 3, description: 'Speaking rate the model generates at, for models that support one. Omit to use the saved voice speed. Unlike speed, it changes the generated audio.' },
  format: { ...enumeration('mp3', 'm4b'), default: 'mp3' }, speed: { type: 'number', minimum: 0.5, maximum: 3, default: 1 },
  chapter: { type: ['integer', 'null'], minimum: 0, description: 'Zero-based index. A chapter builds already-settled audio; it does not start generation.' },
  retrySkipped: { ...boolean, description: 'Retry skipped segments of a whole book.' }, includeProgress: { ...boolean, default: true },
  settings: { ...ref('PlaybackSettings'), description: 'Advanced explicit settings used by the web app. Omit to use saved preferences.' },
  planning: object({ maxBlockLength: integer, language: string, skipBlockKinds: array(enumeration(...PARSED_PDF_BLOCK_KINDS)) }, []), planObjectKey: string,
}, []);

/** The implemented v1 library and audiobook contract. */
export const publicApiSpec = {
  openapi: '3.1.0',
  info: { title: 'OpenReader public API', version: '1.0.0', description:
    'Library and audiobook control API authenticated by browser cookies or scoped OAuth access tokens. OAuth requires a non-guest account. Use resource={instance origin}/api/v1 during authorization. Resources belong to the caller. Heavy work returns status immediately. Relative resource URLs resolve against the instance origin.' },
  servers: [{ url: '/api/v1' }],
  security: [{ sessionCookie: [] }, { secureSessionCookie: [] }, { oauth: [] }],
  paths: {
    '/openapi.json': { get: operation('getOpenApi', 'Read this specification', null, { '200': response('OpenAPI 3.1 document.', { type: 'object' }) }) },
    '/me': { get: operation('getMe', 'Read the current identity, scopes and speech usage', 'documents:read', { '200': response('Current caller.', ref('Me')) }) },
    '/documents': {
      get: operation('listDocuments', 'List or search owned documents', 'documents:read', { '200': response('One page of metadata; status is available from the item route.', ref('DocumentList')) },
        { parameters: [...paging, parameter('q', 'query', { ...string, maxLength: 512 }, false, 'Literal, case-insensitive filename substring.'),
          parameter('folderId', 'query', string, false, 'Empty selects unfiled documents; omitted selects all.'), parameter('ids', 'query', string, false, 'Comma-separated canonical IDs, at most 200.')] }),
      post: operation('createDocument', 'Create from text, a public URL or a transferred upload', 'documents:write', {
        '201': { ...response('Canonical document registered. A PDF may still be processing.', ref('Document')), headers: { Location: { schema: string } } },
        '202': { ...response('DOCX conversion pending. Observe events, then GET statusUrl to register the resulting PDF.', ref('Upload')), headers: { Location: { schema: string } } },
      }, { requestBody: body(ref('CreateDocument')) }),
      patch: operation('moveDocuments', 'Move up to 200 owned documents', 'documents:write', { '200': response('Updated document metadata.', object({ data: array(ref('DocumentMetadata')) })) },
        { requestBody: body(object({ ids, folderId: nullableString })) }),
      delete: operation('deleteDocuments', 'Delete explicitly selected documents', 'documents:write', { '200': response('Number of owned documents deleted; unknown IDs are ignored.', object({ deleted: integer })) },
        { parameters: [parameter('ids', 'query', string, true, 'Required comma-separated canonical IDs, at most 200.')] }),
    },
    '/documents/{id}': {
      parameters: [parameter('id', 'path', docId)],
      get: operation('getDocument', 'Read document metadata and preparation status', 'documents:read', { '200': response('Document; this read does not open the reader or create playback plans.', ref('Document')) }),
      patch: operation('updateDocument', 'Rename or move one document', 'documents:write', { '200': response('Updated document.', ref('Document')) },
        { requestBody: body(object({ name: { ...string, minLength: 1 }, folderId: nullableString }, [])) }),
      delete: operation('deleteDocument', 'Delete a document and schedule artifact cleanup', 'documents:write', { '204': noContent }),
    },
    '/documents/{id}/file': { parameters: [parameter('id', 'path', docId)],
      get: operation('getDocumentFile', 'Read the canonical file (PDF for converted DOCX)', 'documents:read', { '200': fileResponse, '307': redirectResponse }) },
    '/uploads': { post: operation('prepareUpload', 'Prepare an owner-scoped file transfer', 'documents:write', { '201': response('Transfer descriptor. PUT bytes to url using every returned header, then POST /documents.', ref('PreparedUpload')) },
      { requestBody: body(object({ name: { ...string, minLength: 1 }, size: { type: 'integer', minimum: 1 },
        lastModified: { type: 'integer', minimum: 1 }, author: string, language: string }, ['name', 'size'])) }) },
    '/uploads/{uploadId}': { parameters: [parameter('uploadId', 'path', { type: 'string', format: 'uuid' })],
      get: operation('getUpload', 'Read conversion status and finalize the canonical document', 'documents:write', { '200': response('Upload resource. A successful conversion needs this read to register its document.', ref('Upload')) }) },
    '/uploads/{uploadId}/file': { parameters: [parameter('uploadId', 'path', { type: 'string', format: 'uuid' })],
      put: operation('putUploadFile', 'Transfer bytes in proxy mode', 'documents:write', { '204': noContent },
        { requestBody: { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }, description: 'Use the prepared descriptor instead of constructing this URL. The body must match its declared byte length. Presigned mode rejects proxy transfers. A URL prepared by the MCP docs upload command carries owner, expires and signature query parameters in place of a token, valid for that upload only.' }) },
    '/uploads/{uploadId}/events': { parameters: [parameter('uploadId', 'path', { type: 'string', format: 'uuid' }), parameter('opId', 'query', string, true)],
      get: operation('getUploadEvents', 'Observe an operation belonging to the caller\'s upload', 'documents:read', { '200': eventsResponse }) },
    '/folders': {
      get: operation('listFolders', 'List folders in display order', 'documents:read', { '200': response('A page ordered by position, creation time and ID.', object({ data: array(ref('Folder')), nextCursor: nullableString })) }, { parameters: paging }),
      post: operation('createFolder', 'Create a folder, optionally moving selected documents atomically', 'documents:write', { '201': { ...response('Created folder.', ref('Folder')), headers: { Location: { schema: string } } } },
        { requestBody: body(object({ id: folderId, name: { ...string, minLength: 1 }, documentIds: { ...array(docId), maxItems: 200 } }, ['name'])) }),
      delete: operation('deleteAllFolders', 'Remove all folders while keeping every document', 'documents:write', { '204': noContent }),
    },
    '/folders/{id}': { parameters: [parameter('id', 'path', folderId)],
      patch: operation('updateFolder', 'Rename or reorder a folder', 'documents:write', { '200': response('Updated folder.', ref('Folder')) },
        { requestBody: body(object({ name: { ...string, minLength: 1 }, position: integer }, [])) }),
      delete: operation('deleteFolder', 'Remove a folder while keeping its documents', 'documents:write', { '204': noContent }),
    },
    '/providers': { get: operation('listProviders', 'List enabled speech providers and the models this instance allows', 'documents:read', { '200': response('Every enabled provider; nextCursor is null. Keys and base URLs are never included.', ref('ProviderList')) }) },
    '/voices': { get: operation('listVoices', 'List voices for an enabled speech provider and model', 'documents:read', { '200': response('Entire provider/model catalogue with display names, then the caller\'s cloned voices for that provider and model; nextCursor is null. IDs remain provider-native strings.', ref('VoiceList')) },
      { parameters: [parameter('provider', 'query', { ...string, maxLength: 200 }, false, 'Shared provider slug; omitted follows the caller\'s saved speech provider, then the instance default.'), parameter('model', 'query', { ...string, maxLength: 512 }, false, 'Omitted follows saved model selection when provider is omitted, otherwise the configured provider model policy.')] }) },
    '/documents/{id}/audiobooks': { parameters: [parameter('id', 'path', docId)],
      post: operation('createAudiobook', 'Start or resume a matching audiobook', 'audio:generate', {
        '200': response('The matching file is ready.', ref('Audiobook')), '202': response('Preparation, generation or assembly is pending.', ref('Audiobook')),
        '409': { ...errorResponse, description: 'DOCUMENT_PREPARING: retry after the indicated delay while PDF parsing completes.' },
      }, { requestBody: body(ref('AudiobookRequest')), description: 'Uses saved settings unless explicit settings are provided. Signed-in whole-book requests advance after the tab closes. Guests advance on their own requests. Repeated matching requests reuse the same identity; retrySkipped is for whole books only.' }) },
    '/documents/{id}/audiobooks/lookup': { parameters: [parameter('id', 'path', docId)],
      post: operation('lookupAudiobook', 'Read the export state for matching settings', 'documents:read', { '200': response('Current state; no audiobook request is created.', ref('Audiobook')),
        '409': { ...errorResponse, description: 'DOCUMENT_PREPARING: the PDF has not been parsed yet.' } },
        { requestBody: body(ref('AudiobookRequest')), description: 'Never starts or adopts work. A PDF that has not been parsed returns DOCUMENT_PREPARING when saved settings need its parsed language.' }) },
    '/documents/{id}/audiobooks/{audiobookId}': { parameters: [parameter('id', 'path', docId), parameter('audiobookId', 'path')],
      get: operation('getAudiobook', 'Read a durable audiobook request', 'documents:read', { '200': response('Current audiobook state.', ref('Audiobook')),
        '404': { ...errorResponse, description: 'The request is unknown, settled more than 7 days ago, or names a chapter the document no longer has.' } },
        { description: 'Only a caller with the audio:generate scope also advances the request, for example starting a limited compile that reported waiting. A documents:read caller only observes.' }),
      delete: operation('stopAudiobook', 'Stop a whole-book request and keep generated audio cached', 'audio:generate', { '200': response('Cancelled state, which later reads also report. Chapter Stop is rejected.', ref('Audiobook')) },
        { description: 'Formats and speeds of the same settings share one generation run, so stopping it also cancels the other whole-book requests that share it. POST resumes from the cached audio.' }),
    },
    '/documents/{id}/cached-voices': { parameters: [parameter('id', 'path', docId)],
      get: operation('listCachedVoices', 'List the voices this document already has audio for', 'documents:read', { '200': response('Voices whose cached audio this document can reuse with its current reading settings, newest first. Requesting one of them, with its modelSpeed, reuses that audio.', ref('CachedVoiceList')) }) },
    '/documents/{id}/audiobooks/events': { parameters: [parameter('id', 'path', docId), parameter('opId', 'query', string, true)],
      get: operation('getAudiobookEvents', 'Observe an audiobook operation owned by the caller', 'documents:read', { '200': eventsResponse }) },
    '/documents/{id}/audiobooks/files/{artifactId}': { parameters: [parameter('id', 'path', docId), parameter('artifactId', 'path', { type: 'string', pattern: '^[a-fA-F0-9]{8,128}$' })],
      get: operation('getAudiobookFile', 'Download an authorized finished audiobook', 'documents:read', { '200': fileResponse, '303': redirectResponse }) },
  },
  components: {
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token', description: 'Existing Better Auth session on HTTP deployments.' },
      secureSessionCookie: { type: 'apiKey', in: 'cookie', name: '__Secure-better-auth.session_token', description: 'Existing Better Auth session on HTTPS deployments. Browsers send cookies automatically.' },
      oauth: { type: 'oauth2', description: 'Authorization code with S256 PKCE. Discover issuer metadata at /.well-known/oauth-authorization-server/api/auth and resource metadata at /.well-known/oauth-protected-resource/api/v1. Request the /api/v1 resource explicitly. The same token endpoint also supports the advertised OAuth device grant.', flows: {
        authorizationCode: { authorizationUrl: '/api/auth/oauth2/authorize', tokenUrl: '/api/auth/oauth2/token', refreshUrl: '/api/auth/oauth2/token', scopes: API_SCOPE_LABELS },
      } },
    },
    schemas: {
      Error: object({ error: object({ code: string, message: string, retryAfterMs: { type: 'number', minimum: 0 } }, ['code', 'message']) }),
      DocumentMetadata: object({ id: docId, name: string, size: integer, lastModified: number, type: enumeration('pdf', 'epub', 'docx', 'html'),
        scope: enumeration('user'), folderId: string, recentlyOpenedAt: number, contentVersion: string, author: string, language: string,
        readingProgress: object({ fraction: nullableNumber, updatedAtMs: number }),
      }, ['id', 'name', 'size', 'lastModified', 'type']),
      Document: { allOf: [ref('DocumentMetadata'), object({ status: { ...enumeration('not_started', 'processing', 'ready', 'failed', 'unknown'), description: 'not_started: a PDF has not been parsed yet and reading or generating will start it. unknown: the compute worker could not be reached; retry.' }, operationId: nullableString, error: nullableString,
        webUrl: { type: 'string', format: 'uri' }, fileUrl: string })] },
      DocumentList: object({ data: array(ref('DocumentMetadata')), nextCursor: nullableString }),
      CreateDocument: object({ source: { oneOf: [object({ type: { const: 'text' }, text: { ...string, minLength: 1 } }),
        object({ type: { const: 'url' }, url: { type: 'string', format: 'uri', description: 'A public link. A PDF, EPUB, DOCX, Markdown or text file is kept as that file, up to the upload limit; a web page becomes Markdown.' } }), object({ type: { const: 'upload' }, uploadId: { type: 'string', format: 'uuid' } })] },
        name: string, folderId: nullableString, author: string, language: string,
      }, ['source']),
      PreparedUpload: object({ id: { type: 'string', format: 'uuid' }, url: string, headers: { type: 'object', additionalProperties: string }, expiresAt: number }),
      Upload: object({ id: { type: 'string', format: 'uuid' }, status: enumeration('pending', 'processing', 'ready', 'failed'),
        document: { anyOf: [ref('Document'), { type: 'null' }] }, operationId: nullableString, error: nullableString, statusUrl: string, eventsUrl: nullableString }),
      Folder: object({ id: folderId, name: string, position: integer, createdAt: number, updatedAt: number }),
      ProviderList: object({ data: array(object({ id: string, name: string, type: string, defaultModel: string, selected: boolean, selectedModel: { type: ['string', 'null'] }, models: array(object({ id: string, name: string })), acceptsCustomModel: boolean })), nextCursor: { type: 'null' } }),
      VoiceList: object({ data: array(object({ id: string, name: string })), nextCursor: { type: 'null' }, provider: string, model: string,
        status: { ...enumeration('listed', 'defaults', 'unreachable'), description: 'listed: the provider named these voices. defaults: it has no voice list, so these are its standard voices. unreachable: it did not answer, so they are unconfirmed.' } }),
      CachedVoiceList: object({ data: array(object({ provider: string, model: string, voice: string, name: string,
        modelSpeed: { type: 'number', description: 'Speaking rate the cached audio was generated at.' },
        segments: integer, durationMs: { ...integer, description: 'Cached narration at 1x.' }, updatedAt: number })), nextCursor: { type: 'null' } }),
      Me: object({ id: string, isAnonymous: boolean, scopes: array(enumeration('documents:read', 'documents:write', 'audio:generate')),
        computeLimits: object({ enabled: boolean, allowed: boolean, currentCount: number, limit: nullableNumber, remainingChars: nullableNumber,
          resetTimeMs: number, userType: enumeration('anonymous', 'authenticated'), storageLimit: string },
          ['enabled', 'allowed', 'currentCount', 'limit', 'remainingChars', 'resetTimeMs', 'userType']) }),
      PlaybackSettings: object({ providerRef: string, providerType: string, ttsModel: string, voice: string, nativeSpeed: number,
        ttsInstructions: string, ttsModelOptions: { ...string, maxLength: 16384 }, language: string,
        speechText: object({ citations: boolean, brackets: enumeration(...BRACKETED_TEXT_MODES) }),
        voiceCustomization: object({ pieceCharacterLimit: { type: ['integer', 'null'], minimum: 50, maximum: 450 },
          piecePauseMilliseconds: { type: ['integer', 'null'], minimum: 0, maximum: 2000 }, blockPauseMilliseconds: { type: ['integer', 'null'], minimum: 0, maximum: 2000 } }, []),
      }, ['providerRef', 'providerType', 'ttsModel', 'voice', 'nativeSpeed']),
      AudiobookRequest: audiobookBody,
      Audiobook: object({ id: string, documentId: docId, status: { ...enumeration(...generationStates, 'building', 'waiting', 'ready', 'cancelled'), description: 'cancelled: someone stopped the request. A POST with the same settings resumes it from the cached audio.' },
        progress: { type: ['number', 'null'], minimum: 0, maximum: 1 }, format: enumeration('mp3', 'm4b'), speed: number,
        chapter: { type: ['integer', 'null'] }, downloadUrl: nullableString, filename: nullableString, webUrl: { type: 'string', format: 'uri' }, webDownloadUrl: { type: ['string', 'null'], format: 'uri' }, retryAfterMs: nullableNumber,
        generation: object({ state: enumeration(...generationStates), operationId: nullableString, issue: { anyOf: [issue, { type: 'null' }] } }),
        segments: { anyOf: [segmentProgress, { type: 'null' }] }, artifact: object({ state: enumeration(...artifactStates), operationId: nullableString, issue: { anyOf: [issue, { type: 'null' }] } }),
      }),
    },
  },
};
