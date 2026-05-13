'use client';

import type { Rendition } from 'epubjs';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

type EpubMappedPosition = {
  node: Text;
  offset: number;
};

type EpubMappedChar = {
  char: string;
  position: EpubMappedPosition;
};

export type EpubRenderedTextMap = {
  sourceKey: string;
  chars: EpubMappedPosition[];
  content: {
    cfiFromRange: (range: Range) => string;
  };
};

const cloneMappedChar = (char: string, source: EpubMappedChar): EpubMappedChar => ({
  char,
  position: source.position,
});

const replaceMappedUrls = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const text = tokens.map((token) => token.char).join('');
  const urlPattern = /\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi;
  const replaced: EpubMappedChar[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    replaced.push(...tokens.slice(cursor, start));

    const anchor = tokens[start] ?? tokens[Math.max(0, end - 1)];
    if (anchor) {
      const replacement = `- (link to ${match[1]}) -`;
      for (const char of replacement) {
        replaced.push(cloneMappedChar(char, anchor));
      }
    }
    cursor = end;
  }

  replaced.push(...tokens.slice(cursor));
  return replaced;
};

const removeMappedHyphenation = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const text = tokens.map((token) => token.char).join('');
  const hyphenPattern = /(\w+)-\s+(\w+)/g;
  const replaced: EpubMappedChar[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = hyphenPattern.exec(text)) !== null) {
    const start = match.index;
    const full = match[0];
    const first = match[1];
    const second = match[2];
    const secondOffset = full.lastIndexOf(second);

    replaced.push(...tokens.slice(cursor, start));
    replaced.push(...tokens.slice(start, start + first.length));
    replaced.push(...tokens.slice(start + secondOffset, start + secondOffset + second.length));
    cursor = start + full.length;
  }

  replaced.push(...tokens.slice(cursor));
  return replaced;
};

const normalizeMappedTokensForTts = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const withoutLinks = replaceMappedUrls(tokens);
  const withoutHyphenation = removeMappedHyphenation(withoutLinks);
  const normalized: EpubMappedChar[] = [];
  let pendingWhitespace: EpubMappedChar | null = null;

  const flushWhitespace = () => {
    if (!pendingWhitespace || normalized.length === 0 || normalized[normalized.length - 1].char === ' ') {
      pendingWhitespace = null;
      return;
    }
    normalized.push(cloneMappedChar(' ', pendingWhitespace));
    pendingWhitespace = null;
  };

  for (const token of withoutHyphenation) {
    if (token.char === '*') continue;
    if (/\s/.test(token.char)) {
      pendingWhitespace ??= token;
      continue;
    }

    flushWhitespace();
    normalized.push(token);
  }

  if (normalized[normalized.length - 1]?.char === ' ') {
    normalized.pop();
  }

  return normalized;
};

const collectMappedTextFromRange = (range: Range): EpubMappedChar[] => {
  const root = range.commonAncestorContainer;
  const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const mapped: EpubMappedChar[] = [];

  const addTextSlice = (textNode: Text, start: number, end: number) => {
    const text = textNode.textContent || '';
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, text.length));
    for (let offset = safeStart; offset < safeEnd; offset += 1) {
      mapped.push({
        char: text[offset],
        position: { node: textNode, offset },
      });
    }
  };

  if (root.nodeType === Node.TEXT_NODE) {
    addTextSlice(root as Text, range.startOffset, range.endOffset);
    return mapped;
  }

  const nodeFilter = doc.defaultView?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(
    root,
    nodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        try {
          return range.intersectsNode(node)
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT;
        } catch {
          return nodeFilter.FILTER_REJECT;
        }
      },
    },
  );

  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const text = textNode.textContent || '';
    let start = 0;
    let end = text.length;

    if (textNode === range.startContainer) start = range.startOffset;
    if (textNode === range.endContainer) end = range.endOffset;

    addTextSlice(textNode, start, end);
    textNode = walker.nextNode() as Text | null;
  }

  return mapped;
};

export const buildRenderedTextMaps = (
  rendition: Rendition,
  rangeCfi: string,
  sourceKey: string,
): EpubRenderedTextMap[] => {
  const contents = rendition.getContents();
  const contentsArray = Array.isArray(contents) ? contents : [contents];
  const maps: EpubRenderedTextMap[] = [];

  for (const content of contentsArray) {
    try {
      const range = content.range(rangeCfi);
      if (!range) continue;

      const normalized = normalizeMappedTokensForTts(collectMappedTextFromRange(range));
      if (!normalized.length) continue;

      maps.push({
        sourceKey,
        chars: normalized.map((token) => token.position),
        content,
      });
    } catch {
      // Not every displayed iframe can resolve every CFI in spread mode.
    }
  }

  return maps;
};

export const createRangeFromMappedOffsets = (
  map: EpubRenderedTextMap,
  startOffset: number,
  endOffset: number,
): Range | null => {
  const start = Math.max(0, Math.min(startOffset, map.chars.length));
  const end = Math.max(start, Math.min(endOffset, map.chars.length));
  if (end <= start) return null;

  const startPosition = map.chars[start];
  const endPosition = map.chars[end - 1];
  if (!startPosition || !endPosition) return null;

  const doc = startPosition.node.ownerDocument;
  const range = doc.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);
  return range;
};

export const resolveVisibleSegmentRange = (
  maps: EpubRenderedTextMap[],
  segment: CanonicalTtsSegment | null | undefined,
): { map: EpubRenderedTextMap; range: Range; startOffset: number; endOffset: number } | null => {
  if (!segment) return null;

  for (const map of maps) {
    const startsInMap = segment.startAnchor.sourceKey === map.sourceKey;
    const endsInMap = segment.endAnchor.sourceKey === map.sourceKey;
    if (!startsInMap && !endsInMap) continue;

    const startOffset = startsInMap ? segment.startAnchor.offset : 0;
    const endOffset = endsInMap ? segment.endAnchor.offset : map.chars.length;
    const range = createRangeFromMappedOffsets(map, startOffset, endOffset);
    if (range) {
      return { map, range, startOffset, endOffset };
    }
  }

  return null;
};
