import { describe, expect, it } from 'vitest';
import { DEFAULT_TYPOGRAPHY, DEFAULT_HIGHLIGHT_APPEARANCE, normalizeTypography, normalizeTypographyOverride, normalizeHighlightOverride, highlightBackground } from '@/lib/shared/reader-appearance';
import { mergeDocumentSettings, preserveDocumentAppearance } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { sanitizePreferencesPatch } from '@/lib/server/user/preferences-normalize';

describe('reader presentation preferences', () => {
  it('preserves recent presentation edits through speech-only writes, while allowing explicit resets', () => {
    const previous = { ...DEFAULT_DOCUMENT_SETTINGS, typography: { sizePercent: 135 }, highlightAppearance: { wordColor: '#123456' } };
    expect(preserveDocumentAppearance({ ...DEFAULT_DOCUMENT_SETTINGS, language: 'fr' }, previous)).toEqual({ ...previous, language: 'fr' });
    expect(preserveDocumentAppearance({ ...DEFAULT_DOCUMENT_SETTINGS, typography: {}, highlightAppearance: {} }, previous).typography).toEqual({});
  });
  it('bounds malformed values without converting inherited fields to overrides', () => {
    expect(normalizeTypographyOverride({ sizePercent: 999, lineMultiplier: NaN, fontFamily: 'remote-font', letterSpacing: -5 })).toEqual({ sizePercent: 160, letterSpacing: 0 });
    expect(normalizeTypography({ readingWidth: 0 })).toEqual({ ...DEFAULT_TYPOGRAPHY, readingWidth: 40 });
    expect(normalizeHighlightOverride({ wordColor: 'url(secret)', segmentColor: '#AABBCC', wordOpacity: Infinity, segmentOpacity: -1 })).toEqual({ segmentColor: '#aabbcc', segmentOpacity: 0 });
  });
  it('round trips book overrides and explicit reset without dropping speech choices', () => {
    const stored = { ...DEFAULT_DOCUMENT_SETTINGS, voiceOverride: { providerRef: 'local', ttsModel: 'kokoro', voice: 'af_heart' }, typography: { sizePercent: 130 }, highlightAppearance: { wordColor: '#123456' } };
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, stored)).toEqual(stored);
    const reset = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { ...stored, typography: {}, highlightAppearance: {} });
    expect(reset.typography).toEqual({});
    expect(reset.highlightAppearance).toEqual({});
    expect(reset.voiceOverride).toEqual(stored.voiceOverride);
  });
  it('syncs global preferences and restores inherited fields independently', () => {
    const { patch } = sanitizePreferencesPatch({ readerTypography: { sizePercent: 120 }, highlightAppearance: { segmentOpacity: 0.3 } }, { showAllProviderModels: true, sharedProviders: [] }, { fillMissingProvider: false });
    expect(patch.readerTypography).toEqual({ ...DEFAULT_TYPOGRAPHY, sizePercent: 120 });
    expect(patch.highlightAppearance).toEqual({ ...DEFAULT_HIGHLIGHT_APPEARANCE, segmentOpacity: 0.3 });
    expect(normalizeTypography({ ...patch.readerTypography, ...{ fontFamily: 'mono' } }).sizePercent).toBe(120);
    expect(highlightBackground({ ...DEFAULT_HIGHLIGHT_APPEARANCE, wordColor: '#123456', wordOpacity: 0 }, 'word')).toContain('#123456 0%');
  });
});
