import { expect, test } from '@playwright/test';
import {
  buildProportionalAlignment,
  buildTtsSegmentId,
  buildTtsSegmentSettingsHash,
  buildTtsSegmentTextHash,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
} from '../../src/lib/server/tts/segments';

test.describe('tts segment helpers', () => {
  test('builds stable settings hash', () => {
    const a = buildTtsSegmentSettingsHash({
      ttsProvider: 'openai',
      ttsModel: 'gpt-4o-mini-tts',
      voice: 'alloy',
      nativeSpeed: 1,
      ttsInstructions: 'calm',
    });
    const b = buildTtsSegmentSettingsHash({
      ttsProvider: 'openai',
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
    expect(locator).toEqual({ readerType: 'pdf', page: 2 });
    expect(locatorFingerprint(locator)).toHaveLength(64);
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
    expect(stable).toEqual({
      readerType: 'epub',
      spineHref: 'OEBPS/ch02.xhtml',
      spineIndex: 2,
      charOffset: 128,
      cfi: 'epubcfi(/6/4!/4:0)',
    });
    expect(locatorFingerprint(stable)).toHaveLength(64);

    // Legacy/draft EPUB shape (CFI in `location` but no spine coords) is
    // rejected so we never persist viewport-dependent locators.
    const legacy = normalizeLocator({ readerType: 'epub', location: 'epubcfi(/6/4!/4:0)' });
    expect(legacy).toBeNull();
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
});
