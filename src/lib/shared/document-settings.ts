import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
  type DocumentVoiceOverride,
} from '@/types/document-settings';
import { PARSED_PDF_BLOCK_KINDS, type ParsedPdfBlockKind } from '@/types/parsed-pdf';
import { normalizeLanguageTag } from '@openreader/tts/language';
import { normalizeTypographyOverride, normalizeHighlightOverride } from './reader-appearance';
import { normalizeSpeechTextOverride } from '@openreader/tts/speech-text';
import { normalizeVoiceCustomizationOverride } from '@openreader/tts/voice-customization';
import { normalizeReaderPresentationOverride } from './reader-presentation';
import { clampTtsSegmentMaxBlockLength } from '@/types/config';

export function normalizeSkipKinds(value: unknown): ParsedPdfBlockKind[] {
  if (!Array.isArray(value)) return [];
  const allow = new Set(PARSED_PDF_BLOCK_KINDS);
  const out: ParsedPdfBlockKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!allow.has(entry as ParsedPdfBlockKind)) continue;
    out.push(entry as ParsedPdfBlockKind);
  }
  return Array.from(new Set(out));
}

/** Model speeds the voice panel offers; stored values outside them are dropped. */
export const MODEL_SPEED_MIN = 0.5;
export const MODEL_SPEED_MAX = 3;

function normalizeVoiceOverride(value: unknown): DocumentVoiceOverride | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const providerRef = typeof rec.providerRef === 'string' ? rec.providerRef.trim() : '';
  const ttsModel = typeof rec.ttsModel === 'string' ? rec.ttsModel.trim() : '';
  if (!providerRef || !ttsModel) return undefined;
  const voice = typeof rec.voice === 'string' && rec.voice.trim() ? rec.voice.trim() : undefined;
  const voiceSpeed = typeof rec.voiceSpeed === 'number'
    && Number.isFinite(rec.voiceSpeed)
    && rec.voiceSpeed >= MODEL_SPEED_MIN
    && rec.voiceSpeed <= MODEL_SPEED_MAX
    ? rec.voiceSpeed
    : undefined;
  if (voice === undefined && voiceSpeed === undefined) return undefined;
  return {
    providerRef,
    ttsModel,
    ...(voice !== undefined ? { voice } : {}),
    ...(voiceSpeed !== undefined ? { voiceSpeed } : {}),
  };
}

export function mergeDocumentSettings(
  defaults: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
  stored: unknown,
): DocumentSettings {
  const rec = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const rawLanguage = typeof rec.language === 'string' ? rec.language.trim() : '';
  const language = !rawLanguage || rawLanguage.toLowerCase() === 'auto'
    ? 'auto'
    : normalizeLanguageTag(rawLanguage, defaults.language || 'en');
  const pdf = rec.pdf && typeof rec.pdf === 'object' ? rec.pdf as Record<string, unknown> : null;
  const voiceOverride = normalizeVoiceOverride(rec.voiceOverride);
  const playback = rec.playback && typeof rec.playback === 'object' ? rec.playback as Record<string, unknown> : null;

  return {
    schemaVersion: 1,
    language,
    ...(pdf ? { pdf: { ...(Array.isArray(pdf.skipBlockKinds) ? { skipBlockKinds: normalizeSkipKinds(pdf.skipBlockKinds) } : {}) } } : {}),
    ...(voiceOverride ? { voiceOverride } : {}),
    ...(rec.typography ? { typography: normalizeTypographyOverride(rec.typography) } : {}),
    ...(rec.highlightAppearance ? { highlightAppearance: normalizeHighlightOverride(rec.highlightAppearance) } : {}),
    ...(rec.speechText ? { speechText: normalizeSpeechTextOverride(rec.speechText) } : {}),
    ...(rec.voiceCustomization ? { voiceCustomization: normalizeVoiceCustomizationOverride(rec.voiceCustomization) } : {}),
    ...(rec.presentation ? { presentation: normalizeReaderPresentationOverride(rec.presentation) } : {}),
    ...(playback ? { playback: { ...(typeof playback.maxSegmentLength === 'number' && Number.isFinite(playback.maxSegmentLength)
      ? { maxSegmentLength: clampTtsSegmentMaxBlockLength(playback.maxSegmentLength) } : {}) } } : {}),
  };
}

/** Omitted presentation fields are preserved for speech-only and older clients.
 * An explicit empty object resets a book to global inheritance. */
export function preserveDocumentAppearance(incoming: DocumentSettings, previous: DocumentSettings): DocumentSettings {
  return {
    ...incoming,
    ...(incoming.typography === undefined && previous.typography !== undefined ? { typography: previous.typography } : {}),
    ...(incoming.highlightAppearance === undefined && previous.highlightAppearance !== undefined ? { highlightAppearance: previous.highlightAppearance } : {}),
    ...(incoming.speechText === undefined && previous.speechText !== undefined ? { speechText: previous.speechText } : {}),
    ...(incoming.voiceCustomization === undefined && previous.voiceCustomization !== undefined ? { voiceCustomization: previous.voiceCustomization } : {}),
    ...(incoming.presentation === undefined && previous.presentation !== undefined ? { presentation: previous.presentation } : {}),
    ...(incoming.playback === undefined && previous.playback !== undefined ? { playback: previous.playback } : {}),
    ...(incoming.pdf === undefined && previous.pdf !== undefined ? { pdf: previous.pdf } : {}),
  };
}

/**
 * The voice and model speed a book plays with: its own picks while the
 * provider and model they were made for are in use, else the user's default.
 * The reader bootstrap and the client use this one rule, so both build the
 * same plan identity.
 */
export function resolveBookVoice(input: {
  override: DocumentVoiceOverride | undefined;
  providerRef: string;
  ttsModel: string;
  defaultVoice: string;
  defaultVoiceSpeed: number;
}): { voice: string; voiceSpeed: number; ownVoice: boolean; ownVoiceSpeed: boolean } {
  const override = input.override
    && input.override.providerRef === input.providerRef
    && input.override.ttsModel === input.ttsModel
    ? input.override
    : undefined;
  return {
    voice: override?.voice ?? input.defaultVoice,
    voiceSpeed: override?.voiceSpeed ?? input.defaultVoiceSpeed,
    ownVoice: override?.voice !== undefined,
    ownVoiceSpeed: override?.voiceSpeed !== undefined,
  };
}
