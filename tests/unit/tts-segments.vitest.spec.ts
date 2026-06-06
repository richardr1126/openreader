import { describe, expect, test } from 'vitest';
import {
  buildProportionalAlignment,
  buildTtsSegmentEntryId,
  buildTtsSegmentId,
  buildTtsSegmentSettingsHash,
  buildTtsSegmentTextHash,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  projectSegmentLocator,
} from '../../src/lib/server/tts/segments';

describe('tts segment helpers', () => {
  test('builds stable settings hash', () => {
    const a = buildTtsSegmentSettingsHash({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'gpt-4o-mini-tts',
      voice: 'alloy',
      nativeSpeed: 1,
      ttsInstructions: 'calm',
    });
    const b = buildTtsSegmentSettingsHash({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'gpt-4o-mini-tts',
      voice: 'alloy',
      nativeSpeed: 1,
      ttsInstructions: 'calm',
    });
    expect(a).toBe(b);
  });

  test('builds deterministic segment id', () => {
    const id1 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 2,
      normalizedText: 'hello world',
      locatorFingerprint: 'loc',
    });
    const id2 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 2,
      normalizedText: 'hello world',
      locatorFingerprint: 'loc',
    });
    const id3 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 3,
      normalizedText: 'hello world',
      locatorFingerprint: 'loc',
    });
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  test('builds deterministic segment entry id independent of settings', () => {
    const entry1 = buildTtsSegmentEntryId({
      documentId: 'doc',
      documentVersion: 1,
      segmentIndex: 2,
      segmentKey: 'doc:v1:segment-a',
      locatorIdentityKey: 'epub:2:OEBPS/ch02.xhtml:128',
      textHash: 'abc123',
    });
    const entry2 = buildTtsSegmentEntryId({
      documentId: 'doc',
      documentVersion: 1,
      segmentIndex: 2,
      segmentKey: 'doc:v1:segment-a',
      locatorIdentityKey: 'epub:2:OEBPS/ch02.xhtml:128',
      textHash: 'abc123',
    });
    const entry3 = buildTtsSegmentEntryId({
      documentId: 'doc',
      documentVersion: 1,
      segmentIndex: 2,
      segmentKey: 'doc:v1:segment-b',
      locatorIdentityKey: 'epub:2:OEBPS/ch02.xhtml:128',
      textHash: 'abc123',
    });
    expect(entry1).toBe(entry2);
    expect(entry1).not.toBe(entry3);
  });

  test('canonical segment key makes id independent of locator and index', () => {
    const id1 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 2,
      segmentKey: 'doc:v1:segment-a',
      normalizedText: 'hello world',
      locatorFingerprint: 'loc-a',
    });
    const id2 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 99,
      segmentKey: 'doc:v1:segment-a',
      normalizedText: 'hello world',
      locatorFingerprint: 'loc-b',
    });
    const id3 = buildTtsSegmentId({
      documentId: 'doc',
      documentVersion: 1,
      settingsHash: 'abc',
      segmentIndex: 2,
      segmentKey: 'doc:v1:segment-b',
      normalizedText: 'hello world',
      locatorFingerprint: 'loc-a',
    });
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  test('does not leak plaintext via text hash', () => {
    const hash = buildTtsSegmentTextHash('plain sentence', 'secret');
    expect(hash).not.toContain('plain');
    expect(hash).toHaveLength(64);
  });

  test('normalizes PDF locators and creates fingerprints', () => {
    const locator = normalizeLocator({ readerType: 'pdf', page: 2.9 });
    if (!locator) throw new Error('expected normalized pdf locator');
    expect(locator).toEqual({ readerType: 'pdf', page: 2 });
    expect(locatorFingerprint(locator)).toHaveLength(64);
    expect(projectSegmentLocator(locator)).toMatchObject({
      locatorReaderRank: 1,
      locatorReaderType: 'pdf',
      locatorPage: 2,
      locatorIdentityKey: 'pdf:2',
    });
  });

  test('normalizes stable EPUB locators and rejects legacy CFI-only drafts', () => {
    // Stable shape: passes through with floors and trims applied.
    const stable = normalizeLocator({
      readerType: 'epub',
      spineHref: '  OEBPS/ch02.xhtml  ',
      spineIndex: 2.7,
      charOffset: 128.4,
      cfi: '  epubcfi(/6/4!/4:0)  ',
    });
    if (!stable) throw new Error('expected normalized epub locator');
    expect(stable).toEqual({
      readerType: 'epub',
      spineHref: 'OEBPS/ch02.xhtml',
      spineIndex: 2,
      charOffset: 128,
      cfi: 'epubcfi(/6/4!/4:0)',
    });
    expect(locatorFingerprint(stable)).toHaveLength(64);
    expect(projectSegmentLocator(stable)).toMatchObject({
      locatorReaderRank: 0,
      locatorReaderType: 'epub',
      locatorSpineIndex: 2,
      locatorCharOffset: 128,
      locatorSpineHref: 'OEBPS/ch02.xhtml',
      locatorIdentityKey: 'epub:2:OEBPS/ch02.xhtml:128',
    });

    // Legacy/draft EPUB shape (CFI in `location` but no spine coords) is
    // rejected so we never persist viewport-dependent locators.
    const legacy = normalizeLocator({ readerType: 'epub', location: 'epubcfi(/6/4!/4:0)' });
    expect(legacy).toBeNull();
  });

  test('projects html locators into stable manifest sort fields', () => {
    expect(projectSegmentLocator({ readerType: 'html', location: '#intro' })).toMatchObject({
      locatorReaderRank: 2,
      locatorReaderType: 'html',
      locatorLocation: '#intro',
      locatorIdentityKey: 'html:#intro',
    });
  });

  test('builds proportional alignment preserving order', () => {
    const alignment = buildProportionalAlignment({
      sentence: normalizeSegmentText('Hello world again'),
      sentenceIndex: 5,
      durationMs: 1500,
    });
    expect(alignment.sentenceIndex).toBe(5);
    expect(alignment.words.length).toBe(3);
    expect(alignment.words[0].startSec).toBe(0);
    expect(alignment.words[2].endSec).toBeGreaterThan(1.4);
    expect(alignment.words[1].charStart).toBeGreaterThan(alignment.words[0].charStart);
  });

  test('builds proportional alignment for no-space languages', () => {
    const sentence = 'これは日本語です';
    const alignment = buildProportionalAlignment({
      sentence,
      sentenceIndex: 2,
      durationMs: 1200,
      language: 'ja',
    });

    expect(alignment.words.length).toBeGreaterThan(1);
    for (const word of alignment.words) {
      expect(sentence.slice(word.charStart, word.charEnd)).toBe(word.text);
    }
  });
});
