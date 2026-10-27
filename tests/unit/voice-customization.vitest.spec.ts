import { describe, expect, test } from 'vitest';
import { AUTOMATIC_VOICE_CUSTOMIZATION as automatic, normalizeVoiceCustomization, normalizeVoiceCustomizationOverride } from '@openreader/tts/voice-customization';
import { buildTTSCacheKey } from '@openreader/tts/generate';
import { buildTtsPlaybackSettingsHash, buildTtsSegmentSettingsJson } from '@openreader/tts/segments';
import { mergeDocumentSettings, preserveDocumentAppearance } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { parseTtsSegmentSettings } from '@/lib/server/tts/playback-request';
import { sanitizePreferencesPatch } from '@/lib/server/user/preferences-normalize';
import { estimateAddedPauseMs } from '@openreader/tts/voice-customization';
import { buildPlaybackCbrLayout } from '@openreader/tts/playback-cbr-layout';
import { buildPlaybackGrid } from '@/lib/server/tts/playback-plans';

const settings = { providerRef: 'local', providerType: 'kokoro-local' as const, ttsModel: 'kokoro', voice: 'af_heart', nativeSpeed: 1 };
const segmentation = { maxBlockLength: 450, language: 'en', enforceSourceBoundaries: false, skipBlockKinds: [], isPlainText: false, namespace: null };
const hash = (voiceCustomization?: typeof automatic, providerType = settings.providerType as string) => buildTtsPlaybackSettingsHash({ ...settings, providerType: providerType as typeof settings.providerType, voiceCustomization }, segmentation);

describe('voice customization storage and audio identity', () => {
  test('normalizes finite bounds while keeping Automatic separate from explicit zero', () => {
    expect(normalizeVoiceCustomization(undefined)).toEqual(automatic);
    expect(normalizeVoiceCustomization({ pieceCharacterLimit: 900, piecePauseMilliseconds: -1, blockPauseMilliseconds: Infinity })).toEqual({ ...automatic, pieceCharacterLimit: 450, piecePauseMilliseconds: 0 });
    expect(normalizeVoiceCustomizationOverride({ pieceCharacterLimit: null, blockPauseMilliseconds: 0 })).toEqual({ pieceCharacterLimit: null, blockPauseMilliseconds: 0 });
    expect(normalizeVoiceCustomizationOverride({ blockPauseMilliseconds: '500' })).toEqual({});
  });

  test('retains released cache keys for Automatic and zero; custom local splits and gaps vary independently', () => {
    const old = hash();
    expect(hash(automatic)).toBe(old);
    expect(hash({ ...automatic, piecePauseMilliseconds: 0, blockPauseMilliseconds: 0 })).toBe(old);
    for (const voiceCustomization of [
      { ...automatic, pieceCharacterLimit: 100 },
      { ...automatic, piecePauseMilliseconds: 500 },
      { ...automatic, blockPauseMilliseconds: 500 },
    ]) expect(hash(voiceCustomization)).not.toBe(old);
    expect(hash({ ...automatic, pieceCharacterLimit: 100, piecePauseMilliseconds: 500 }, 'custom-openai')).toBe(hash(undefined, 'custom-openai'));
    expect(hash({ ...automatic, blockPauseMilliseconds: 500 }, 'custom-openai')).not.toBe(hash(undefined, 'custom-openai'));
    expect(buildTtsSegmentSettingsJson({ ...settings, voiceCustomization: automatic })).toEqual(buildTtsSegmentSettingsJson(settings));
  });

  test('in-memory synthesis deduplication separates customized audio', () => {
    const request = { text: 'The cat sat.', voice: 'af_heart', speed: 1, provider: 'kokoro-local', apiKey: '' };
    expect(buildTTSCacheKey({ ...request, voiceCustomization: automatic })).toBe(buildTTSCacheKey(request));
    expect(buildTTSCacheKey({ ...request, voiceCustomization: { ...automatic, pieceCharacterLimit: 50 } })).not.toBe(buildTTSCacheKey(request));
  });

  test('persists independent book fields, explicit Automatic overrides, and resets without losing appearance', () => {
    const previous = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { typography: { sizePercent: 125 }, voiceCustomization: { piecePauseMilliseconds: null, blockPauseMilliseconds: 0 } });
    expect(previous.voiceCustomization).toEqual({ piecePauseMilliseconds: null, blockPauseMilliseconds: 0 });
    expect(preserveDocumentAppearance(DEFAULT_DOCUMENT_SETTINGS, previous).voiceCustomization).toEqual(previous.voiceCustomization);
    expect(preserveDocumentAppearance({ ...DEFAULT_DOCUMENT_SETTINGS, voiceCustomization: {} }, previous).voiceCustomization).toEqual({});
    expect(preserveDocumentAppearance({ ...DEFAULT_DOCUMENT_SETTINGS, voiceCustomization: {} }, previous).typography).toEqual(previous.typography);
    const global = { ...automatic, piecePauseMilliseconds: 150, blockPauseMilliseconds: 1000 };
    expect(normalizeVoiceCustomization({ ...global, ...previous.voiceCustomization })).toEqual({ ...automatic, blockPauseMilliseconds: 0 });
  });

  test('app preferences and request settings retain the normalized contract', () => {
    const value = { ...automatic, blockPauseMilliseconds: 500 };
    expect(sanitizePreferencesPatch({ voiceCustomization: value }, { showAllProviderModels: true, sharedProviders: [] }, { fillMissingProvider: false }).patch.voiceCustomization).toEqual(value);
    expect(parseTtsSegmentSettings({ ...settings, voiceCustomization: value })?.voiceCustomization).toEqual(value);
  });

  test('pending slots include pauses; exact durations never count them twice', () => {
    const value = { ...automatic, blockPauseMilliseconds: 2000 };
    const addedPauseMs = estimateAddedPauseMs('Hi.', value, 'custom-openai');
    const layout = buildPlaybackCbrLayout([{ ordinal: 0, text: 'Hi.', durationMs: null, addedPauseMs }], 0, 78);
    expect(layout.durationMs).toBe(2234);
    expect(buildPlaybackCbrLayout([{ ordinal: 0, text: 'Hi.', durationMs: 2300, addedPauseMs }], 0, 78).durationMs).toBe(2300);
    expect(estimateAddedPauseMs('Hi.', value, 'custom-openai', true)).toBeGreaterThan(2000);
  });

  test('bootstrap and stored-session settings give the same seek coordinates after reload', () => {
    const settingsJson = { ...settings, nativeSpeed: 2, voiceCustomization: { ...automatic, blockPauseMilliseconds: 150 } };
    const input = {
      artifact: { schemaVersion: 1 as const, documentId: 'book', documentVersion: 1,
        readerType: 'epub', settingsHash: 'customized', segments: Array.from({ length: 151 }, (_, ordinal) => ({
          ordinal, segmentKey: null, locator: null, text: 'A narration segment.',
        })) },
      completedDurations: new Map([[0, 1000]]), startOrdinal: 0,
    };
    const bootstrap = buildPlaybackGrid({ ...input, settingsJson });
    const resumed = buildPlaybackGrid({ ...input, settingsJson: JSON.stringify(settingsJson) });
    expect(resumed).toEqual(bootstrap);
    expect(resumed.segments[150]!.startMs).toBeGreaterThan(100_000);
    expect(resumed.segments[0]!.durationMs).toBe(1000);
  });
});
