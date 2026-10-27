import { describe, expect, test } from 'vitest';
import { getAppConfigDefaults } from '@/types/config';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { mergeDocumentSettings, preserveDocumentAppearance } from '@/lib/shared/document-settings';
import { normalizeReaderPresentationOverride, resolveReaderPresentation } from '@/lib/shared/reader-presentation';
import { sanitizePreferencesPatch } from '@/lib/server/user/preferences-normalize';

const context = { showAllProviderModels: true, sharedProviders: [] };
const options = { fillMissingProvider: false };

describe('reader defaults and book inheritance', () => {
  test('migrates the shared display preference without changing either document format', () => {
    const { patch, migrated } = sanitizePreferencesPatch({ readerShowsLayout: false }, context, options);
    expect(patch).toEqual({ pdfShowsLayout: false, epubShowsLayout: false });
    expect(migrated).toBe(true);
    expect(sanitizePreferencesPatch({ readerShowsLayout: false, pdfShowsLayout: true }, context, options).patch)
      .toEqual({ pdfShowsLayout: true, epubShowsLayout: false });
  });

  test('preserves separate global display and highlight defaults for each format', () => {
    const config = { ...getAppConfigDefaults(), pdfShowsLayout: false, epubShowsLayout: true,
      pdfHighlightEnabled: false, epubWordHighlightEnabled: false };
    expect(resolveReaderPresentation(config, 'pdf')).toMatchObject({ showsLayout: false, highlightSegment: false, highlightWords: true });
    expect(resolveReaderPresentation(config, 'epub')).toMatchObject({ showsLayout: true, highlightSegment: true, highlightWords: false });
    expect(resolveReaderPresentation(config, 'html')).toMatchObject({ showsLayout: false, highlightSegment: true, highlightWords: true });
  });

  test('explicit false and independent resets survive unrelated book edits', () => {
    const saved = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { presentation: { highlightSegment: false, epubTheme: true } });
    expect(saved.presentation).toEqual({ highlightSegment: false, epubTheme: true });
    expect(preserveDocumentAppearance({ schemaVersion: 1, language: 'de' }, saved).presentation).toEqual(saved.presentation);
    const reset = preserveDocumentAppearance({ schemaVersion: 1, presentation: { epubTheme: true } }, saved);
    expect(resolveReaderPresentation(getAppConfigDefaults(), 'epub', reset.presentation))
      .toMatchObject({ highlightSegment: true, epubTheme: true });
    expect(normalizeReaderPresentationOverride({ highlightWords: 'false', showsLayout: false, viewType: 'invalid' })).toEqual({ showsLayout: false });
  });

  test('absence inherits PDF skip defaults while released arrays, including empty arrays, remain overrides', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, null).pdf).toBeUndefined();
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { pdf: { skipBlockKinds: ['header', 'footer'] } }).pdf)
      .toEqual({ skipBlockKinds: ['header', 'footer'] });
    const explicitNone = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { pdf: { skipBlockKinds: [] } });
    expect(explicitNone.pdf).toEqual({ skipBlockKinds: [] });
    expect(preserveDocumentAppearance({ schemaVersion: 1 }, explicitNone).pdf).toEqual({ skipBlockKinds: [] });
    expect(preserveDocumentAppearance({ schemaVersion: 1, pdf: {} }, explicitNone).pdf).toEqual({});
    expect(sanitizePreferencesPatch({ pdfSkipBlockKinds: ['header', 'header', 'invalid'] }, context, options).patch.pdfSkipBlockKinds).toEqual(['header']);
  });

  test('book segment limits normalize, persist and reset independently of voice customization', () => {
    const saved = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { playback: { maxSegmentLength: 2000 }, voiceCustomization: { blockPauseMilliseconds: 500 } });
    expect(saved.playback).toEqual({ maxSegmentLength: 1200 });
    expect(preserveDocumentAppearance({ schemaVersion: 1 }, saved).playback).toEqual(saved.playback);
    const reset = preserveDocumentAppearance({ schemaVersion: 1, playback: {} }, saved);
    expect(reset.playback).toEqual({});
    expect(reset.voiceCustomization).toEqual({ blockPauseMilliseconds: 500 });
  });
});
