/** Speech-only filtering. Source text and canonical segment identities never change. */
import type { TTSSentenceAlignment, TTSSegmentLocator } from './types';
export type BracketedTextMode = 'off' | 'square' | 'parentheses' | 'both';
export type SpeechTextOptions = { citations: boolean; brackets: BracketedTextMode };
export const DEFAULT_SPEECH_TEXT: SpeechTextOptions = { citations: false, brackets: 'off' };
export const BRACKETED_TEXT_MODES = ['off', 'square', 'parentheses', 'both'] as const;

export function normalizeSpeechText(value: unknown): SpeechTextOptions {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    citations: raw.citations === true,
    brackets: BRACKETED_TEXT_MODES.includes(raw.brackets as BracketedTextMode)
      ? raw.brackets as BracketedTextMode : 'off',
  };
}

export function normalizeSpeechTextOverride(value: unknown): Partial<SpeechTextOptions> {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...(typeof raw.citations === 'boolean' ? { citations: raw.citations } : {}),
    ...(BRACKETED_TEXT_MODES.includes(raw.brackets as BracketedTextMode) ? { brackets: raw.brackets as BracketedTextMode } : {}),
  };
}

export function speechTextEnabled(options: SpeechTextOptions): boolean {
  return options.citations || options.brackets !== 'off';
}

export type SpokenText = {
  text: string;
  /** UTF-16 source offset for each spoken code unit; absent is the identity map. */
  sourceOffsets?: number[];
};

const numericCitation = /^\s*\d+(?:\s*[-–—,;]\s*\d+)*\s*$/u;
const authorYearCitation = /^\s*[\p{L}][\p{L}\p{M}'’.,&\-\s]*?[,\s]+(?:1[5-9]|20|21)\d{2}[a-z]?(?:\s*,\s*(?:pp?\.\s*)?\d+(?:\s*[-–]\s*\d+)?)?(?:\s*;\s*[\p{L}][\p{L}\p{M}'’.,&\-\s]*?[,\s]+(?:1[5-9]|20|21)\d{2}[a-z]?(?:\s*,\s*(?:pp?\.\s*)?\d+(?:\s*[-–]\s*\d+)?)?)*\s*$/u;

function omittedRanges(text: string, options: SpeechTextOptions): Array<[number, number]> {
  const stack: Array<{ start: number; open: string }> = [];
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '[' || character === '(') stack.push({ start: index, open: character });
    else if (character === ']' || character === ')') {
      const group = stack.pop();
      if (!group) continue;
      if (group.open !== (character === ']' ? '[' : '(')) { stack.length = 0; continue; }
      const content = text.slice(group.start + 1, index);
      const omitBracket = options.brackets === 'both'
        || options.brackets === 'square' && group.open === '['
        || options.brackets === 'parentheses' && group.open === '(';
      const omitCitation = options.citations && (
        group.open === '[' && numericCitation.test(content) || authorYearCitation.test(content)
      );
      if (omitBracket || omitCitation) ranges.push([group.start, index + 1]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** Full section context is resolved before windowing, including deep-start seeks. */
export function mapSpeechTextSegments<T extends { ordinal: number; text: string }>(
  segments: readonly T[], options: SpeechTextOptions, section: (segment: T) => string,
): Map<number, SpokenText> {
  const result = new Map<number, SpokenText>();
  if (!speechTextEnabled(options)) return result;
  let first = 0;
  while (first < segments.length) {
    let last = first + 1;
    while (last < segments.length && section(segments[last]) === section(segments[first])) last += 1;
    const text = segments.slice(first, last).map((segment) => segment.text).join(' ');
    const ranges = omittedRanges(text, options);
    let offset = 0;
    let rangeIndex = 0;
    for (let index = first; index < last; index += 1) {
      const segment = segments[index];
      const end = offset + segment.text.length;
      while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= offset) rangeIndex += 1;
      if (rangeIndex < ranges.length && ranges[rangeIndex][0] < end) {
        const characters: string[] = [];
        const sourceOffsets: number[] = [];
        let pendingSpace: number | null = null;
        let localRange = rangeIndex;
        for (let local = 0; local < segment.text.length; local += 1) {
          const global = offset + local;
          while (localRange < ranges.length && ranges[localRange][1] <= global) localRange += 1;
          if (localRange < ranges.length && ranges[localRange][0] <= global) {
            const next = text[ranges[localRange][1]] ?? '';
            if (/[\p{L}\p{N}]/u.test(characters[characters.length - 1] ?? '') && /[\p{L}\p{N}]/u.test(next)) pendingSpace = local;
            continue;
          }
          const character = segment.text[local];
          if (/\s/u.test(character)) { pendingSpace = local; continue; }
          if (pendingSpace !== null && characters.length > 0 && !/[.,;:!?…]/u.test(character)) {
            characters.push(' '); sourceOffsets.push(pendingSpace);
          }
          pendingSpace = null;
          characters.push(character); sourceOffsets.push(local);
        }
        result.set(segment.ordinal, { text: characters.join(''), sourceOffsets });
      }
      offset = end + 1;
    }
    first = last;
  }
  return result;
}

export function mapSpokenRange(mapping: SpokenText, start: number, end: number): [number, number] | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > mapping.text.length) return null;
  if (!mapping.sourceOffsets) return [start, end];
  return [mapping.sourceOffsets[start], mapping.sourceOffsets[end - 1] + 1];
}

export function speechTextSection(locator: TTSSegmentLocator | null): string {
  if (locator?.readerType === 'epub') return `epub:${locator.spineIndex}:${locator.spineHref}`;
  if (locator?.readerType === 'pdf') return `pdf:${locator.page}`;
  return 'flow';
}

export function remapSpeechAlignment<T extends TTSSentenceAlignment>(source: string, mapping: SpokenText, alignment: T): T {
  if (!mapping.sourceOffsets) return alignment;
  return { ...alignment, sentence: source, words: alignment.words.flatMap((word) => {
    const range = word.charStart === undefined || word.charEnd === undefined
      ? null : mapSpokenRange(mapping, word.charStart, word.charEnd);
    return range ? [{ ...word, charStart: range[0], charEnd: range[1] }] : [];
  }) };
}
