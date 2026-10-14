/**
 * Word splitting and part-of-speech tags for the Misaki port.
 *
 * The iOS port leans on Apple's `NLTagger` for both; upstream Misaki on
 * spaCy. Neither exists here, so this module stands in for `NLTagger`: it
 * splits the text itself, the way the Swift code expects to receive it, and
 * asks `compromise` (MIT, pure JS) only for each word's part of speech, read
 * back by character offset. compromise's own tokens are not used because they
 * fold punctuation into words, expand contractions into invisible terms and
 * split "5km" — none of which the downstream port expects.
 *
 * Tags come out Penn-style (`NN`, `VBD`, `-LRB-`, ...), which is what Lexicon
 * reads. Only a handful of them change a pronunciation: noun/verb variants
 * ("read", "live", "used"), `DT`/`TO`/`IN` for the function words, and `NNP`.
 */

import nlp from 'compromise/two';
import { CURRENCIES } from './lexicon';

export interface TaggedSlice {
  start: number;
  end: number;
  tag: string;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const APOSTROPHES = new Set(["'", '’', '‘']);
const QUOTES = new Set(['"', '“', '”', "'", '‘', '’', '«', '»']);
const OPEN_QUOTES = new Set(['“', '«']);
const CLOSE_QUOTES = new Set(['”', '»']);

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && WORD_CHAR.test(character);
}

/**
 * Splits text into word and punctuation spans. A word runs over letters,
 * digits and marks, through an apostrophe that has a letter after it ("don't",
 * "Richard's"), a full stop with a letter or digit on both sides ("3.5",
 * "U.S"), and a comma between digits ("1,000"). Every other character that is
 * not whitespace is a span of its own. `abbreviations` are the dictionary's
 * dotted entries ("Mr.", "Dr."), which keep their full stop when one follows,
 * as spaCy's tokenizer exceptions do upstream.
 */
export function splitWords(text: string, abbreviations: ReadonlySet<string>): Array<{ start: number; end: number }> {
  const characters = Array.from(text);
  const offsets: number[] = [];
  let position = 0;
  for (const character of characters) {
    offsets.push(position);
    position += character.length;
  }
  offsets.push(position);

  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (!isWordChar(character)) {
      spans.push({ start: offsets[index]!, end: offsets[index + 1]! });
      index += 1;
      continue;
    }
    let end = index + 1;
    for (;;) {
      const next = characters[end];
      if (isWordChar(next)) {
        end += 1;
        continue;
      }
      const after = characters[end + 1];
      const before = characters[end - 1];
      if (next !== undefined && APOSTROPHES.has(next) && after !== undefined && LETTER.test(after)) {
        end += 2;
        continue;
      }
      if (next === '.' && isWordChar(before) && isWordChar(after)) {
        end += 2;
        continue;
      }
      if (next === ',' && before !== undefined && DIGIT.test(before) && after !== undefined && DIGIT.test(after)) {
        end += 2;
        continue;
      }
      break;
    }
    if (
      characters[end] === '.'
      && end + 1 < characters.length
      && /\s/u.test(characters[end + 1]!)
      && abbreviations.has(`${characters.slice(index, end).join('')}.`)
    ) {
      end += 1;
    }
    spans.push({ start: offsets[index]!, end: offsets[end]! });
    index = end;
  }
  return spans;
}

interface CompromiseTerm {
  tags: string[];
  offset: { start: number; length: number };
}

function wordTags(text: string): Array<{ start: number; end: number; tags: Set<string> }> {
  const sentences = nlp(text).json({ offset: true }) as Array<{ terms: CompromiseTerm[] }>;
  const terms: Array<{ start: number; end: number; tags: Set<string> }> = [];
  for (const sentence of sentences) {
    for (const term of sentence.terms) {
      // Zero-length terms are compromise's own inventions: the "not" of
      // "don't", the unit of "5km". They cover no characters.
      if (term.offset.length <= 0) continue;
      terms.push({
        start: term.offset.start,
        end: term.offset.start + term.offset.length,
        tags: new Set(term.tags),
      });
    }
  }
  return terms;
}

/** Penn-style tag for one word, from compromise's tags for the term under it. */
export function mapWordTag(word: string, tags: ReadonlySet<string> | null): string {
  if (Object.hasOwn(CURRENCIES, word)) return '$';
  if (word === '#') return '#';
  if (/\p{N}/u.test(word)) return 'CD';
  if (tags !== null) {
    if (tags.has('Pronoun')) return 'PRP';
    if (tags.has('Determiner')) return 'DT';
    if (tags.has('Preposition')) return word.toLowerCase() === 'to' ? 'TO' : 'IN';
    if (tags.has('Conjunction')) return 'CC';
    if (tags.has('Verb')) {
      const lower = word.toLowerCase();
      if (tags.has('Gerund') || lower.endsWith('ing')) return 'VBG';
      if (tags.has('Participle')) return 'VBN';
      if (
        tags.has('PastTense')
        || lower === 'used'
        || lower.endsWith('ed')
        || ['was', 'were', 'did', 'had'].includes(lower)
      ) {
        return 'VBD';
      }
      if (tags.has('PresentTense') && !tags.has('Infinitive') && lower.endsWith('s')) return 'VBZ';
      return 'VB';
    }
    if (tags.has('Adjective')) return 'JJ';
    if (tags.has('Adverb')) return 'RB';
    if (tags.has('Expression')) return 'UH';
    if (tags.has('Noun') || tags.has('ProperNoun')) {
      if (tags.has('ProperNoun') || tags.has('Person') || tags.has('Place') || tags.has('Organization')) return 'NNP';
      const letters = Array.from(word);
      if (word === word.toUpperCase() && word !== word.toLowerCase() && letters.length <= 4) return 'NNP';
      const [first, ...rest] = letters;
      const tail = rest.join('');
      if (first !== undefined && /\p{Lu}/u.test(first) && tail === tail.toLowerCase()) return 'NNP';
      return 'NN';
    }
  }
  return Array.from(word).every((c) => LETTER.test(c)) ? 'NN' : 'NFP';
}

/** Tag for a span that is a single punctuation or symbol character. */
function mapPunctuationTag(character: string, previous: string | undefined): string {
  if (Object.hasOwn(CURRENCIES, character)) return '$';
  if (character === '#') return '#';
  if (character === ',') return ',';
  if (character === '.' || character === '!' || character === '?') return '.';
  if (character === '(' || character === '[' || character === '{') return '-LRB-';
  if (character === ')' || character === ']' || character === '}') return '-RRB-';
  if (QUOTES.has(character)) {
    if (OPEN_QUOTES.has(character)) return '``';
    if (CLOSE_QUOTES.has(character)) return '""';
    // A straight or ambiguous quote opens when nothing word-like is touching
    // it on the left.
    const opens = previous === undefined || /[\s([{\-—–]/u.test(previous);
    return opens ? '``' : '""';
  }
  return ':';
}

/** Word and punctuation spans of `text`, each with a Penn-style tag. */
export function tagText(text: string, abbreviations: ReadonlySet<string>): TaggedSlice[] {
  const spans = splitWords(text, abbreviations);
  if (spans.length === 0) return [];
  const terms = spans.some((span) => isWordChar(text.slice(span.start, span.end).charAt(0)))
    ? wordTags(text)
    : [];

  let termIndex = 0;
  return spans.map((span) => {
    const piece = text.slice(span.start, span.end);
    const first = Array.from(piece)[0]!;
    if (!isWordChar(first)) {
      return { ...span, tag: mapPunctuationTag(first, span.start > 0 ? text[span.start - 1] : undefined) };
    }
    while (termIndex < terms.length && terms[termIndex]!.end <= span.start) termIndex += 1;
    const term = terms[termIndex];
    const tags = term !== undefined && term.start < span.end ? term.tags : null;
    return { ...span, tag: mapWordTag(piece, tags) };
  });
}
