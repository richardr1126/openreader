import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { db } from '@openreader/database';
import { documentSettings, documents, userPreferences } from '@openreader/database/schema';
import type { AudiobookCaller, AudiobookIntent } from '@/lib/server/audiobooks/audiobooks';
import { apiErrorResponse } from '@/lib/server/api/responses';
import { resolveApiPrincipal, type ApiPrincipal, type ApiScope } from '@/lib/server/api/principal';
import { detectParsedPdfLanguage, ensurePdfReady, storedRecord } from '@/lib/server/reader/bootstrap';
import { resolveDefaultPlaybackRequest } from '@/lib/server/reader/playback';
import { parseTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import { resolveUserDocumentScope } from '@/lib/server/tts/segments-auth';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

/** Authorizes a v1 audiobook request for one document. */
export async function resolveAudiobookCaller(
  request: NextRequest,
  documentId: string,
  requiredScope: ApiScope,
): Promise<AudiobookCaller | Response> {
  const principal = await resolveApiPrincipal(request, requiredScope);
  if (principal instanceof Response) return principal;
  return audiobookCaller(principal, documentId);
}

export async function audiobookCaller(principal: ApiPrincipal, documentId: string): Promise<AudiobookCaller | Response> {
  const scope = await resolveUserDocumentScope(principal, documentId);
  if (!scope) return apiErrorResponse(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  return {
    scope,
    clientId: principal.clientId,
    mayGenerate: principal.scopes.includes('audio:generate'),
    subject: { userId: principal.userId, isAnonymous: principal.isAnonymous },
  };
}

export type AudiobookBody = {
  record: Record<string, unknown>;
  format: 'mp3' | 'm4b';
  speed: number;
  chapterIndex: number | null;
};

/** Reads the fields every audiobook body shares. */
export function parseAudiobookBody(value: unknown): AudiobookBody | Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return apiErrorResponse(400, 'REQUEST_INVALID', 'Send a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.format !== undefined && record.format !== 'mp3' && record.format !== 'm4b') {
    return apiErrorResponse(400, 'REQUEST_INVALID', 'format must be mp3 or m4b.');
  }
  const speed = record.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 3) {
    return apiErrorResponse(400, 'REQUEST_INVALID', 'speed must be a number from 0.5 to 3.');
  }
  // JSON numbers only: `Number("")` and `Number(false)` would select chapter 0.
  const chapter = record.chapter;
  if (chapter !== undefined && chapter !== null && !(typeof chapter === 'number' && Number.isInteger(chapter) && chapter >= 0)) {
    return apiErrorResponse(400, 'REQUEST_INVALID', 'chapter must be a non-negative integer.');
  }
  return {
    record,
    format: record.format ?? 'mp3',
    // Speed is part of the request identity, so near-equal values must not multiply requests.
    speed: Math.round(speed * 100) / 100,
    chapterIndex: typeof chapter === 'number' ? chapter : null,
  };
}

/**
 * Builds the intent from explicit settings, which the web app sends so an
 * export matches the reader's plan and audio cache exactly, or from the user's
 * saved settings with an optional voice. Saved settings depend on the PDF's
 * detected language, so a PDF must finish parsing first; a start begins the parse,
 * while a lookup only reports that it is not ready.
 */
export async function resolveAudiobookIntent(
  caller: AudiobookCaller,
  documentId: string,
  body: AudiobookBody,
  options: { observeOnly?: boolean } = {},
): Promise<AudiobookIntent | Response> {
  const { record, format, speed, chapterIndex } = body;
  const base = { format, speed, chapterIndex };
  if (record.settings !== undefined) {
    const parsed = parseTtsPlaybackRequestBody({
      documentId,
      settings: record.settings,
      ...(record.planning === undefined ? {} : { planning: record.planning }),
      ...(record.planObjectKey === undefined ? {} : { planObjectKey: record.planObjectKey }),
    });
    if (!parsed) return apiErrorResponse(400, 'REQUEST_INVALID', 'settings or planning is invalid.');
    if (parsed.planObjectKey) {
      const { artifact } = await readTtsPlaybackPlanArtifact(parsed.planObjectKey);
      if (artifact.documentId !== documentId || artifact.documentVersion !== caller.scope.documentVersion
        || artifact.readerType !== caller.scope.readerType
        || (artifact.storageUserId !== undefined && artifact.storageUserId !== caller.scope.storageUserId)
        || (caller.clientId !== undefined && artifact.storageUserId !== caller.scope.storageUserId)) {
        return apiErrorResponse(403, 'PLAN_FORBIDDEN', 'The reading plan does not belong to this document.');
      }
    }
    return { ...base, parsed };
  }
  if (record.voice !== undefined && (typeof record.voice !== 'string' || !record.voice.trim())) {
    return apiErrorResponse(400, 'REQUEST_INVALID', 'voice must be a voice ID.');
  }

  const { scope } = caller;
  let parsedPdf: ParsedPdfDocument | null = null;
  if (scope.readerType === 'pdf') {
    const pdf = await ensurePdfReady(documentId, scope, {
      observeOnly: options.observeOnly,
      throwAdmissionLimit: true,
    });
    if ('result' in pdf) {
      return pdf.result.status === 'error' && !pdf.result.retryable
        ? apiErrorResponse(422, 'DOCUMENT_UNAVAILABLE', pdf.result.message)
        : apiErrorResponse(409, 'DOCUMENT_PREPARING', 'This PDF is still being prepared.', { retryAfterMs: 5_000 });
    }
    parsedPdf = pdf.parsedDocument;
  }
  const [documentRows, settingsRows, preferenceRows] = await Promise.all([
    db.select({ language: documents.language }).from(documents).where(and(
      eq(documents.id, documentId),
      eq(documents.userId, scope.storageUserId),
    )).limit(1),
    db.select({ dataJson: documentSettings.dataJson }).from(documentSettings).where(and(
      eq(documentSettings.documentId, documentId),
      eq(documentSettings.userId, scope.storageUserId),
    )).limit(1),
    db.select({ dataJson: userPreferences.dataJson }).from(userPreferences)
      .where(eq(userPreferences.userId, scope.userId)).limit(1),
  ]);
  const savedLanguage = (documentRows[0] as { language: string | null } | undefined)?.language ?? null;
  const parsed = await resolveDefaultPlaybackRequest(
    documentId,
    scope,
    mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, storedRecord(settingsRows[0]?.dataJson)),
    storedRecord(preferenceRows[0]?.dataJson),
    savedLanguage || (parsedPdf ? detectParsedPdfLanguage(parsedPdf) : null),
    typeof record.voice === 'string' ? record.voice.trim() : undefined,
  );
  if ('error' in parsed) return apiErrorResponse(503, 'PROVIDER_UNAVAILABLE', parsed.error, { retryAfterMs: 5_000 });
  return {
    ...base,
    parsed,
  };
}
