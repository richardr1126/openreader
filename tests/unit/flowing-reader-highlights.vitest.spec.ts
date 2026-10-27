import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';
import type { HtmlBlock } from '@openreader/tts/html-blocks';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import { useEPUBHighlighting } from '@/hooks/epub/useEPUBHighlighting';
import {
  clearHtmlSentenceHighlight,
  highlightHtmlSentence,
  highlightHtmlWord,
  HTML_SENTENCE_CLASS,
  HTML_WORD_CLASS,
} from '@/lib/client/html/highlight';

const epub = vi.hoisted(() => ({
  resolve: vi.fn(), createRange: vi.fn(), paint: vi.fn(() => true), clear: vi.fn(),
}));
const reader = vi.hoisted(() => ({ config: vi.fn(), playback: vi.fn(), highlight: vi.fn() }));
vi.mock('@/contexts/ConfigContext', () => ({ useConfig: reader.config }));
vi.mock('@/contexts/TTSContext', () => ({ useTTS: reader.playback, useTTSHighlight: reader.highlight }));
vi.mock('@/lib/client/epub/epub-rendered-text-maps', () => ({
  resolveVisibleSegmentRange: epub.resolve,
  createRangeFromMappedOffsets: epub.createRange,
}));
vi.mock('@/lib/client/highlight-range-painter', () => ({
  paintRangeHighlight: epub.paint,
  clearRangeHighlight: epub.clear,
}));

const alignment: TTSSentenceAlignment = {
  sentenceIndex: 0,
  sentence: 'The quick brown fox',
  words: ['The', 'quick', 'brown', 'fox'].map((text, index) => ({
    text, startSec: index, endSec: index + 1,
  })),
};
const segment: CanonicalTtsSegment = {
  key: 'first', text: alignment.sentence, ordinal: 0, ownerSourceKey: 'first-block',
  ownerLocator: { readerType: 'html', location: 'first-block' },
  startAnchor: { sourceKey: 'first-block', offset: 0 },
  endAnchor: { sourceKey: 'first-block', offset: alignment.sentence.length },
  spansSourceBoundary: false,
};
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div><div id="text"><p>The <strong>quick</strong> brown fox</p><p>Next sentence</p></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#ef4444' }));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  // LinkeDOM omits Text.splitText; model its standard DOM operation here.
  Object.defineProperty(dom.window.Text.prototype, 'splitText', {
    configurable: true,
    value(this: Text, offset: number) {
      const tail = this.ownerDocument.createTextNode(this.data.slice(offset));
      this.data = this.data.slice(0, offset);
      this.parentNode?.insertBefore(tail, this.nextSibling);
      return tail;
    },
  });
  root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  container = dom.document.getElementById('text') as unknown as HTMLElement;
  epub.resolve.mockReset();
  epub.createRange.mockReset();
  epub.paint.mockClear();
  epub.clear.mockClear();
  reader.playback.mockReturnValue({ resolvedLanguage: 'en', playbackPlanReady: true,
    playbackPlanSegmentCount: 1, playbackSegments: [segment], skipToOrdinal: vi.fn() });
  reader.highlight.mockReturnValue({ currentSegment: segment, currentSentence: alignment.sentence,
    currentSentenceAlignment: alignment, currentWordIndex: 1 });
});

afterEach(async () => {
  clearHtmlSentenceHighlight();
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('HTML region mapping and independent paint', () => {
  test.each([false, true])('maps consecutive words with segment paint %s', (paintSentence) => {
    expect(highlightHtmlSentence(container, alignment.sentence, 'en', [], paintSentence)).toBe(true);
    expect(container.querySelectorAll(`.${HTML_SENTENCE_CLASS}`).length > 0).toBe(paintSentence);
    for (let index = 0; index < alignment.words.length; index += 1) {
      expect(highlightHtmlWord(container, alignment, index)).toBe(true);
      expect(Array.from(container.querySelectorAll(`.${HTML_WORD_CLASS}`), (span) => span.textContent).join(''))
        .toBe(alignment.words[index].text);
    }
    expect(highlightHtmlSentence(container, 'Next sentence', 'en', [], paintSentence)).toBe(true);
    const next = { sentenceIndex: 1, sentence: 'Next sentence', words: [
      { text: 'Next', startSec: 0, endSec: 1 }, { text: 'sentence', startSec: 1, endSec: 2 },
    ] };
    expect(highlightHtmlWord(container, next, 1)).toBe(true);
    expect(container.querySelector(`.${HTML_WORD_CLASS}`)?.textContent).toBe('sentence');
    clearHtmlSentenceHighlight();
    expect(container.querySelector('span')).toBeNull();
    expect(container.textContent).toBe('The quick brown foxNext sentence');
  });

  test('switches segment paint without losing the selected word or source markup', () => {
    for (const paintSentence of [true, false, true]) {
      expect(highlightHtmlSentence(container, alignment.sentence, 'en', [], paintSentence)).toBe(true);
      expect(highlightHtmlWord(container, alignment, 1)).toBe(true);
      expect(container.querySelector(`.${HTML_WORD_CLASS}`)?.textContent).toBe('quick');
      expect(container.querySelector('strong')?.textContent).toBe('quick');
      expect(container.querySelectorAll(`.${HTML_SENTENCE_CLASS}`).length > 0).toBe(paintSentence);
    }
  });
});

describe('flowing text reader preferences', () => {
  test('preserves the current word through preference toggles and a block remount', async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    let blocks: HtmlBlock[] = [{ index: 0, anchorId: 'first-block', kind: 'paragraph',
      raw: 'The **quick** brown fox', plainText: alignment.sentence }];
    for (const [segmentEnabled, wordEnabled] of [[true, true], [false, true], [false, false], [true, false], [true, true]]) {
      reader.config.mockReturnValue({ htmlHighlightEnabled: segmentEnabled, htmlWordHighlightEnabled: wordEnabled });
      await act(async () => root.render(createElement(HTMLViewer, { blocks, format: 'markdown', onReady, onError })));
      const rendered = document.getElementById('root')!;
      expect(Boolean(rendered.querySelector(`.${HTML_SENTENCE_CLASS}`))).toBe(segmentEnabled);
      expect(rendered.querySelector(`.${HTML_WORD_CLASS}`)?.textContent ?? null).toBe(wordEnabled ? 'quick' : null);
    }
    blocks = blocks.map((block) => ({ ...block }));
    await act(async () => root.render(createElement(HTMLViewer, { blocks, format: 'markdown', onReady, onError })));
    expect(document.getElementById('root')!.querySelector(`.${HTML_WORD_CLASS}`)?.textContent).toBe('quick');
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  test('word-only initial readiness reports a missing segment mapping', async () => {
    reader.config.mockReturnValue({ htmlHighlightEnabled: false, htmlWordHighlightEnabled: true });
    const blocks: HtmlBlock[] = [{ index: 0, anchorId: 'first-block', kind: 'paragraph',
      raw: 'Entirely different content', plainText: 'Entirely different content' }];
    const onReady = vi.fn();
    const onError = vi.fn();
    await act(async () => root.render(createElement(HTMLViewer, { blocks, format: 'text', onReady, onError })));
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  for (const readerType of ['html', 'pdf', 'epub'] as const) {
    for (const format of ['text', 'markdown'] as const) {
      test.each([[false, false], [false, true], [true, false], [true, true]])(
        `${readerType} ${format}: segment %s and word %s`, async (segmentEnabled, wordEnabled) => {
          reader.config.mockReturnValue({ [`${readerType}HighlightEnabled`]: segmentEnabled,
            [`${readerType}WordHighlightEnabled`]: wordEnabled });
          const blocks: HtmlBlock[] = [{ index: 0, anchorId: 'first-block', kind: 'paragraph',
            raw: 'The **quick** brown fox', plainText: alignment.sentence }];
          const onReady = vi.fn();
          const onError = vi.fn();
          await act(async () => root.render(createElement(HTMLViewer, { blocks, format, readerType, onReady, onError })));
          const rendered = document.getElementById('root')!;
          expect(Boolean(rendered.querySelector(`.${HTML_SENTENCE_CLASS}`))).toBe(segmentEnabled);
          expect(rendered.querySelector(`.${HTML_WORD_CLASS}`)?.textContent ?? null).toBe(wordEnabled ? 'quick' : null);
          expect(onReady).toHaveBeenCalledOnce();
          expect(onError).not.toHaveBeenCalled();
        },
      );
    }
  }
});

describe('EPUB independent highlight layers', () => {
  test.each([[false, false], [false, true], [true, false], [true, true]])(
    'segment %s and word %s paint independently', async (epubHighlightEnabled, epubWordHighlightEnabled) => {
      const range = { startContainer: { ownerDocument: document } } as unknown as Range;
      epub.resolve.mockReturnValue({ range, map: { text: alignment.sentence, sourceKey: 'chapter' },
        startOffset: 0, endOffset: alignment.sentence.length });
      epub.createRange.mockReturnValue(range);
      let highlights!: ReturnType<typeof useEPUBHighlighting>;
      const maps = { current: [] };
      function Probe() {
        highlights = useEPUBHighlighting({ epubHighlightEnabled, epubWordHighlightEnabled, renderedTextMapsRef: maps });
        return null;
      }
      await act(async () => root.render(createElement(Probe)));
      expect(highlights.highlightSegment(segment)).toBe(true);
      highlights.highlightWordIndex(alignment, 1, segment);
      const names = epub.paint.mock.calls.map((args) => (args as unknown[])[1]);
      expect(names.includes('openreader-epub-segment')).toBe(epubHighlightEnabled);
      expect(names.includes('openreader-epub-word')).toBe(epubWordHighlightEnabled);
    },
  );

  test('word-only readiness requires a mapped segment', async () => {
    let highlights!: ReturnType<typeof useEPUBHighlighting>;
    function Probe() {
      highlights = useEPUBHighlighting({ epubHighlightEnabled: false, epubWordHighlightEnabled: true,
        renderedTextMapsRef: { current: [] } });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    epub.resolve.mockReturnValue(null);
    expect(highlights.highlightSegment(segment)).toBe(false);
  });

  test('disabling segment paint preserves the active word layer', async () => {
    const range = { startContainer: { ownerDocument: document } } as unknown as Range;
    epub.resolve.mockReturnValue({ range, map: { text: alignment.sentence, sourceKey: 'chapter' },
      startOffset: 0, endOffset: alignment.sentence.length });
    epub.createRange.mockReturnValue(range);
    let highlights!: ReturnType<typeof useEPUBHighlighting>;
    const maps = { current: [] };
    function Probe({ segmentEnabled }: { segmentEnabled: boolean }) {
      highlights = useEPUBHighlighting({ epubHighlightEnabled: segmentEnabled, epubWordHighlightEnabled: true,
        renderedTextMapsRef: maps });
      return null;
    }
    await act(async () => root.render(createElement(Probe, { segmentEnabled: true })));
    highlights.highlightSegment(segment);
    highlights.highlightWordIndex(alignment, 1, segment);
    epub.clear.mockClear();
    await act(async () => root.render(createElement(Probe, { segmentEnabled: false })));
    expect(highlights.highlightSegment(segment)).toBe(true);
    expect(epub.clear.mock.calls.map((args) => (args as unknown[])[1]))
      .not.toContain('openreader-epub-word');
    highlights.highlightWordIndex(alignment, 2, segment);
    expect(epub.paint).toHaveBeenLastCalledWith(range, 'openreader-epub-word', expect.any(String), 1);
  });
});
