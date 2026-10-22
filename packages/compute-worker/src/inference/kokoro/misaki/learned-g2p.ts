/**
 * G2P for the Kokoro languages its own pipeline reads through espeak-ng:
 * Spanish, Hindi, Italian and Brazilian Portuguese. Port of the OpenReader iOS
 * `LearnedG2P`; Apache-2.0, see ../assets/LICENSE.txt.
 *
 * espeak-ng is GPL-3 and does not ship. Each language's table is learned
 * offline from espeak's own readings of every Tatoeba sentence in the language
 * (`tools/learned-g2p` in the iOS repository): a lexicon of each word's usual
 * reading in a sentence, letter-to-sound rules for the rest, and rules for how
 * a word's first and last sounds change beside its neighbours. Tokenization
 * and edge context here must match that tool's exactly, or the rules fire in
 * the wrong places.
 */

import { LetterToSound, phonemeSymbols } from './letter-to-sound';
import { normalizeHindiDigits, numberParts, type LearnedLanguage } from './romance-numbers';
import { createToken, type MToken } from './token';

const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';
const PUNCTUATION = new Set(Array.from('.,!?;:"“”«»()[]—–-…¿¡'));
const HINDI_PUNCTUATION = new Set([...PUNCTUATION, ...Array.from("।॥'‘’")]);
/** An acronym of up to this many letters is spelled, as espeak spells "ONU". */
const SPELLED_LENGTH = 3;
const VOWEL_LETTERS = /[aeiouáéíóúàèìòùâêôãõ]/u;
const LETTERS_ONLY = /^\p{L}+$/u;
/** A run of digits with its separators and unit, or a run of anything else. */
const NUMBER_PARTS = /\d+(?:[.,]\d+)*[º°ª%]?|[^\d]+/gu;
const PAUSE = '#';

interface Unit {
  mark: string;
  symbol: string;
}

/** Symbols, each stress mark joined to the symbol after it. */
function units(phonemes: string): Unit[] {
  const out: Unit[] = [];
  let mark = '';
  for (const symbol of phonemeSymbols(phonemes)) {
    if (symbol === PRIMARY || symbol === SECONDARY) {
      mark = symbol;
    } else {
      out.push({ mark, symbol });
      mark = '';
    }
  }
  return out;
}

const join = (list: Unit[]) => list.map((unit) => unit.mark + unit.symbol).join('');

function isAcronym(word: string): boolean {
  return Array.from(word).length >= 2 && LETTERS_ONLY.test(word)
    && word === word.toUpperCase() && word !== word.toLowerCase();
}

/** Lowercase, except that an acronym keeps its capitals: "TV" is spelled. */
function keyOf(word: string): string {
  const straight = word.replaceAll('’', "'");
  return isAcronym(straight) ? straight : straight.toLowerCase();
}

interface Piece {
  lead: string;
  core: string;
  trail: string;
  whitespace: string;
}

function pieces(text: string, language: LearnedLanguage): Piece[] {
  const out: Piece[] = [];
  const punctuation = language === 'hi' ? HINDI_PUNCTUATION : PUNCTUATION;
  const clean = text.normalize('NFC').replace(/\p{Cf}/gu, '');
  for (const match of clean.matchAll(/(\S+)(\s*)/gu)) {
    const chars = Array.from(match[1]!);
    let start = 0;
    let end = chars.length;
    while (start < end && punctuation.has(chars[start]!)) start += 1;
    while (end > start && punctuation.has(chars[end - 1]!)) end -= 1;
    out.push({
      lead: chars.slice(0, start).join(''),
      core: chars.slice(start, end).join(''),
      trail: chars.slice(end).join(''),
      whitespace: match[2] ? ' ' : '',
    });
  }
  return out;
}

export class LearnedG2P {
  private readonly lexicon = new Map<string, string>();
  private readonly edges = new Map<string, string>();
  /** A word's whole reading before a given next sound, keyed `word\tnext`. */
  private readonly wordEdges = new Map<string, string>();
  private readonly letters = new Map<string, string>();
  private readonly numbers = new Map<number, string>();
  private readonly vowels = new Set<string>();
  private readonly finalStress: boolean;
  /** Words that stay unstressed at a clause end all the same. */
  private readonly unstressedFinal = new Set<string>();
  private readonly letterToSound: LetterToSound;

  constructor(readonly language: LearnedLanguage, tsv: string) {
    let finalStress = false;
    for (const line of tsv.split('\n')) {
      const [kind, key, value, reading] = line.split('\t');
      if (kind === 'w' && key && value !== undefined) this.lexicon.set(key, value);
      else if (kind === 'e' && key && value !== undefined) this.edges.set(key, value);
      else if (kind === 'l' && key && value !== undefined) this.letters.set(key, value);
      else if (kind === 'n' && key && value !== undefined) this.numbers.set(Number(key), value);
      else if (kind === 'vowels' && key) key.split(' ').forEach((vowel) => this.vowels.add(vowel));
      else if (kind === 'final') finalStress = true;
      else if (kind === 'u' && key) this.unstressedFinal.add(key);
      else if (kind === 'x' && key && value && reading !== undefined) this.wordEdges.set(`${key}\t${value}`, reading);
    }
    this.finalStress = finalStress;
    this.letterToSound = new LetterToSound(tsv);
  }

  phonemize(text: string): { tokens: MToken[] } {
    const all = pieces(text, this.language);
    const words: Array<{ piece: Piece; phonemes: string; pauseBefore: boolean; pauseAfter: boolean }> = [];
    let pause = true;
    for (const piece of all) {
      if (!piece.core) {
        pause = true;
        continue;
      }
      words.push({ piece, phonemes: this.read(piece.core), pauseBefore: pause || piece.lead !== '', pauseAfter: piece.trail !== '' });
      pause = piece.trail !== '';
    }
    words.forEach((word, index) => {
      word.pauseAfter ||= index === words.length - 1 || words[index + 1]!.pauseBefore;
    });
    const spoken = words.map((word, index) => {
      const previous = word.pauseBefore ? PAUSE : units(words[index - 1]!.phonemes).at(-1)?.symbol ?? PAUSE;
      const next = word.pauseAfter ? PAUSE : this.firstUnit(words[index + 1]!.phonemes);
      const key = keyOf(word.piece.core);
      const known = this.wordEdges.get(`${key}\t${next}`);
      if (known !== undefined) return known;
      const promote = this.finalStress && next === PAUSE && !this.unstressedFinal.has(key);
      return this.applyEdges(word.phonemes, previous, next, promote);
    });

    const tokens: MToken[] = [];
    let wordIndex = 0;
    for (const piece of all) {
      const trail = Array.from(piece.trail);
      for (const mark of piece.lead) tokens.push(createToken({ text: mark, tag: '', whitespace: '', phonemes: this.punctuation(mark) }));
      if (piece.core) {
        tokens.push(createToken({
          text: piece.core,
          tag: '',
          whitespace: trail.length ? '' : piece.whitespace,
          phonemes: spoken[wordIndex] ?? '',
        }));
        wordIndex += 1;
      }
      trail.forEach((mark, index) => tokens.push(createToken({
        text: mark,
        tag: '',
        whitespace: index === trail.length - 1 ? piece.whitespace : '',
        phonemes: this.punctuation(mark),
      })));
    }
    return { tokens };
  }

  private firstUnit(phonemes: string): string {
    const first = units(phonemes)[0];
    return first ? first.mark + first.symbol : PAUSE;
  }

  private punctuation(mark: string): string {
    return this.language === 'hi' && (mark === '।' || mark === '॥') ? '' : mark;
  }

  /** One onset rule, the first coda rule that exists, then clause-final stress. */
  private applyEdges(phonemes: string, previous: string, next: string, promote: boolean): string {
    const list = units(phonemes);
    if (list.length === 0) return phonemes;
    const onset = this.edges.get(`o|${list[0]!.symbol}|${previous}`);
    if (onset !== undefined) list[0] = { ...list[0]!, symbol: onset };
    const last = list.at(-1)!.symbol;
    const lastTwo = list.length >= 2 ? list.at(-2)!.symbol + last : `#${last}`;
    const bareNext = next.replace(/^[ˈˌ]/u, '');
    for (const key of [`c|${lastTwo}|${next}`, `c|${lastTwo}|${bareNext}`, `c|${last}|${next}`, `c|${last}|${bareNext}`]) {
      const coda = this.edges.get(key);
      if (coda !== undefined) {
        list[list.length - 1] = { ...list.at(-1)!, symbol: coda };
        break;
      }
    }
    const result = join(list);
    if (!promote || result.includes(PRIMARY)) return result;
    if (result.includes(SECONDARY)) return result.replace(SECONDARY, PRIMARY);
    const symbols = phonemeSymbols(result);
    const vowel = symbols.findIndex((symbol) => this.vowels.has(symbol));
    return vowel < 0 ? result : [...symbols.slice(0, vowel), PRIMARY, ...symbols.slice(vowel)].join('');
  }

  /** A piece's reading: its words, and any numbers in it spelled out. */
  private read(core: string): string {
    if (this.language === 'hi') core = normalizeHindiDigits(core);
    if (!/\d/u.test(core)) {
      const reading = this.word(keyOf(core));
      if (reading || this.language !== 'hi') return reading;
      // Mixed words such as a domain name still have speakable runs.
      return [...core.matchAll(/[\p{L}\p{M}]+/gu)].map(([word]) => this.word(keyOf(word))).filter(Boolean).join(' ');
    }
    const parts: string[] = [];
    for (const [part] of core.matchAll(NUMBER_PARTS)) {
      const numbers = numberParts(this.language, part);
      if (numbers) {
        parts.push(...numbers.map((item) => (typeof item === 'number' ? this.numbers.get(item) ?? '' : this.word(item))));
        continue;
      }
      // A malformed grouping must not erase the digits from the audio.
      if (this.language === 'hi' && /^\d/u.test(part)) {
        parts.push(...Array.from(part).filter((digit) => /\d/u.test(digit)).map((digit) => this.numbers.get(Number(digit)) ?? ''));
        continue;
      }
      const letters = part.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '');
      if (letters) parts.push(this.language === 'hi' ? this.read(letters) : this.word(keyOf(letters)));
    }
    return parts.filter(Boolean).join(' ');
  }

  private word(key: string): string {
    const known = this.lexicon.get(key);
    if (known !== undefined) return known;
    if (isAcronym(key)) {
      if (Array.from(key).length <= SPELLED_LENGTH || !VOWEL_LETTERS.test(key.toLowerCase())) return this.spell(key);
      const lower = key.toLowerCase();
      return this.lexicon.get(lower) ?? this.letterToSound.guess(lower) ?? this.spell(key);
    }
    return this.letterToSound.guess(key) ?? this.spell(key.toUpperCase());
  }

  /**
   * Letter by letter: every name but the last loses its primary stress and
   * length, and the onset rules run between the letters as between words.
   */
  private spell(word: string): string {
    const names: string[] = [];
    for (const letter of word) {
      const name = this.letters.get(letter.normalize('NFD')[0]!);
      if (name === undefined) return '';
      names.push(name);
    }
    let previous = PAUSE;
    return names.map((name, index) => {
      const list = units(index < names.length - 1 ? name.replaceAll(PRIMARY, SECONDARY).replaceAll('ː', '') : name);
      if (list.length === 0) return '';
      const onset = this.edges.get(`o|${list[0]!.symbol}|${previous}`);
      if (onset !== undefined) list[0] = { ...list[0]!, symbol: onset };
      previous = list.at(-1)!.symbol;
      return join(list);
    }).join('');
  }
}
