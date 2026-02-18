/**
 * Natural Language Processing Utilities
 * 
 * This module provides consistent sentence processing functionality across the application.
 * It handles text preprocessing, sentence splitting, and block creation for optimal TTS processing.
 */

import nlp from 'compromise';

export const MAX_BLOCK_LENGTH = 450;

const splitOversizedText = (text: string, maxLen: number): string[] => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const parts: string[] = [];
  const MAX_OVERFLOW = maxLen; // allow finishing the sentence up to +maxLen chars
  const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);
  const BREAK_CHARS = new Set(['.', '!', '?']);
  const SOFT_BREAK_CHARS = new Set([';', ':']);

  const findPunctuationCut = (s: string, limit: number): number | null => {
    for (let i = limit; i >= 0; i--) {
      const ch = s[i];
      if (!BREAK_CHARS.has(ch)) continue;

      const prev = i > 0 ? s[i - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';

      // Avoid splitting inside decimals like 3.14
      if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue;

      let end = i + 1;
      while (end < s.length && CLOSERS.has(s[end])) end++;
      const after = end < s.length ? s[end] : '';

      // Allow a boundary at end/whitespace, or common PDF artifact where
      // the next sentence starts immediately with an uppercase letter.
      if (!after || /\s/.test(after) || /[A-Z]/.test(after)) return end;
    }
    return null;
  };

  const findForwardPunctuationCut = (
    s: string,
    startIndex: number,
    endIndex: number,
    chars: Set<string>
  ): number | null => {
    const start = Math.max(0, startIndex);
    const end = Math.min(endIndex, s.length - 1);
    for (let i = start; i <= end; i++) {
      const ch = s[i];
      if (!chars.has(ch)) continue;

      const prev = i > 0 ? s[i - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';

      if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue;

      let cut = i + 1;
      while (cut < s.length && CLOSERS.has(s[cut])) cut++;
      const after = cut < s.length ? s[cut] : '';

      if (!after || /\s/.test(after) || /[A-Z]/.test(after)) return cut;
    }
    return null;
  };

  const findSoftPunctuationCut = (s: string, limit: number): number | null => {
    for (let i = limit; i >= 0; i--) {
      const ch = s[i];
      if (!SOFT_BREAK_CHARS.has(ch)) continue;

      let end = i + 1;
      while (end < s.length && CLOSERS.has(s[end])) end++;
      const after = end < s.length ? s[end] : '';
      if (!after || /\s/.test(after) || /[A-Z]/.test(after)) return end;
    }
    return null;
  };

  let remaining = normalized;
  while (remaining.length > maxLen) {
    const backwardLimit = Math.min(maxLen, remaining.length - 1);
    const forwardLimit = Math.min(maxLen + MAX_OVERFLOW, remaining.length - 1);

    let cut =
      findPunctuationCut(remaining, backwardLimit) ??
      findForwardPunctuationCut(remaining, maxLen, forwardLimit, BREAK_CHARS) ??
      findSoftPunctuationCut(remaining, backwardLimit) ??
      findForwardPunctuationCut(remaining, maxLen, forwardLimit, SOFT_BREAK_CHARS) ??
      remaining.lastIndexOf(' ', maxLen);

    if (cut === 0 || cut === -1) {
      // No whitespace or punctuation; hard-cut for extremely long tokens.
      cut = maxLen;
    }

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) parts.push(chunk);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
};

const normalizeSentenceBoundariesForNlp = (text: string): string => {
  // PDF extraction sometimes yields "...end.Next..." with no whitespace.
  // Insert a space only when it looks like a sentence boundary (lower/digit before,
  // uppercase after) to avoid breaking abbreviations like "U.S.A".
  return text
    .replace(/([a-z0-9])([.!?])(?=[A-Z])/g, '$1$2 ')
    .replace(/([a-z0-9][.!?][\"”’)\]])(?=[A-Z])/g, '$1 ');
};

/**
 * Preprocesses text for audio generation by cleaning up various text artifacts
 * 
 * @param {string} text - The text to preprocess
 * @returns {string} The cleaned text
 */
export const preprocessSentenceForAudio = (text: string): string => {
  return text
    .replace(/\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi, '- (link to $1) -')
    .replace(/(\w+)-\s+(\w+)/g, '$1$2') // Remove hyphenation
    // Remove special character *
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Splits text into sentences and groups them into blocks suitable for TTS processing
 * 
 * @param {string} text - The text to split into sentences
 * @returns {string[]} Array of sentence blocks
 */
export const splitTextToTtsBlocks = (text: string): string[] => {
  // Treat double-newlines as paragraph boundaries; single newlines are usually
  // just PDF line wrapping and should not force sentence/block boundaries.
  const paragraphs = text.split(/\n{2,}/);
  const blocks: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;

    const cleanedText = normalizeSentenceBoundariesForNlp(
      preprocessSentenceForAudio(paragraph)
    );
    const doc = nlp(cleanedText);
    const rawSentences = doc.sentences().out('array') as string[];
    
    // Merge multi-sentence dialogue enclosed in quotes into single items
    const mergedSentences = mergeQuotedDialogue(rawSentences);

    let currentBlock = '';

    for (const sentence of mergedSentences) {
      const trimmedSentence = sentence.trim();
      const sentenceParts = splitOversizedText(trimmedSentence, MAX_BLOCK_LENGTH);

      for (const sentencePart of sentenceParts) {
        if (currentBlock && (currentBlock.length + sentencePart.length + 1) > MAX_BLOCK_LENGTH) {
          blocks.push(currentBlock.trim());
          currentBlock = sentencePart;
        } else {
          currentBlock = currentBlock 
            ? `${currentBlock} ${sentencePart}`
            : sentencePart;
        }
      }
    }

    if (currentBlock) {
      blocks.push(currentBlock.trim());
    }
  }
  
  return blocks;
};

/**
 * EPUB block splitting used where we want the produced sentences
 * to closely match the original DOM text (for exact-match highlighting).
 */
export const splitTextToTtsBlocksEPUB = (text: string): string[] => {
  const paragraphs = text.split(/\n+/);
  const blocks: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;

    const cleanedText = preprocessSentenceForAudio(paragraph);
    const doc = nlp(cleanedText);
    const rawSentences = doc.sentences().out('array') as string[];

    const mergedSentences = mergeQuotedDialogue(rawSentences);

    let currentBlock = '';

    for (const sentence of mergedSentences) {
      const trimmedSentence = sentence.trim();
      const sentenceParts =
        trimmedSentence.length > MAX_BLOCK_LENGTH
          ? splitOversizedText(trimmedSentence, MAX_BLOCK_LENGTH)
          : [trimmedSentence];

      for (const sentencePart of sentenceParts) {
        if (currentBlock && (currentBlock.length + sentencePart.length + 1) > MAX_BLOCK_LENGTH) {
          blocks.push(currentBlock.trim());
          currentBlock = sentencePart;
        } else {
          currentBlock = currentBlock
            ? `${currentBlock} ${sentencePart}`
            : sentencePart;
        }
      }
    }

    if (currentBlock) {
      blocks.push(currentBlock.trim());
    }
  }

  return blocks;
};

/**
 * Normalizes text for single-shot TTS generation (e.g., a whole PDF page).
 * Uses the same logic as `splitTextToTtsBlocks`, but returns a single string.
 * 
 * @param {string} text - The text to process
 * @returns {string} Normalized text
 */
export const normalizeTextForTts = (text: string): string =>
  splitTextToTtsBlocks(text).join(' ');

// Helper functions to merge quoted dialogue across sentences
const countDoubleQuotes = (s: string): number => {
  const matches = s.match(/["“”]/g);
  return matches ? matches.length : 0;
};

// Replace the old curly single-quote counter and standalone-straight counter with a unified, context-aware counter
const countNonApostropheSingleQuotes = (s: string): number => {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '‘' || ch === '’') {
      const prev = i > 0 ? s[i - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';
      const isPrevAlphaNum = /[A-Za-z0-9]/.test(prev);
      const isNextAlphaNum = /[A-Za-z0-9]/.test(next);
      // Treat as a real quote mark only when it's not clearly an apostrophe
      // between two alphanumeric characters (e.g., don't, WizardLM’s).
      if (!(isPrevAlphaNum && isNextAlphaNum)) {
        count++;
      }
    }
  }
  return count;
};

const mergeQuotedDialogue = (rawSentences: string[]): string[] => {
  const result: string[] = [];
  let buffer = '';
  let insideDouble = false;
  let insideSingle = false;

  for (const s of rawSentences) {
    const t = s.trim();
    const dblCount = countDoubleQuotes(t);
    // Use the new context-aware single-quote counter so curly apostrophes
    // inside words don't incorrectly toggle quote state and merge large
    // regions of plain prose into one block.
    const singleCount = countNonApostropheSingleQuotes(t);

    if (insideDouble || insideSingle) {
      buffer = buffer ? `${buffer} ${t}` : t;
    } else {
      // Start buffering if this sentence opens an unclosed quote
      if ((dblCount % 2 === 1) || (singleCount % 2 === 1)) {
        buffer = t;
      } else {
        result.push(t);
      }
    }

    // Toggle quote states after processing this sentence
    if (dblCount % 2 === 1) insideDouble = !insideDouble;
    if (singleCount % 2 === 1) insideSingle = !insideSingle;

    // If all open quotes are closed, flush buffer
    if (!(insideDouble || insideSingle) && buffer) {
      result.push(buffer);
      buffer = '';
    }
  }

  if (buffer) {
    result.push(buffer);
  }

  return result;
};
