/**
 * TypeScript port of Misaki's `Lexicon`, from the OpenReader iOS port
 * (vendored from kokoro-swift, itself a port of hexgrad/misaki). Apache-2.0;
 * see ../assets/LICENSE.txt. Local modifications are listed in
 * ../assets/PROVENANCE.md.
 *
 * Upstream hands a word neither dictionary holds to espeak, which is GPLv3.
 * This port never does: after every lookup and a diacritic fold have failed it
 * asks `LetterToSound`, whose rules were induced from these same Apache-2.0
 * dictionaries.
 */

import { NumberToWords } from './number-to-words';
import type { LetterToSound } from './letter-to-sound';
import { cloneToken, type MToken } from './token';

export const DIPHTHONGS = new Set(Array.from('AIOQWYʤʧ'));
export const SUBTOKEN_JUNKS = new Set(Array.from("',-._‘’/"));
export const PUNCTS = new Set(Array.from(';:,.!?—…"“”'));
export const NON_QUOTE_PUNCTS = new Set([...PUNCTS].filter((c) => !'"“”'.includes(c)));
export const PUNCT_TAG_PHONEMES: Record<string, string> = {
  '-LRB-': '(',
  '-RRB-': ')',
  '``': '“',
  '""': '”',
  "''": '”',
};
export const PUNCT_TAGS = new Set(['.', ',', '-LRB-', '-RRB-', '``', '""', "''", ':', '$', '#', 'NFP']);
export const CONSONANTS = new Set(Array.from('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ'));
const US_TAUS = new Set(Array.from('AIOWYiuæɑəɛɪɹʊʌ'));
export const CURRENCIES: Record<string, [string, string]> = {
  $: ['dollar', 'cent'],
  '£': ['pound', 'pence'],
  '€': ['euro', 'cent'],
};
const ORDINALS = new Set(['st', 'nd', 'rd', 'th']);
const ADD_SYMBOLS: Record<string, string> = { '.': 'dot', '/': 'slash' };
export const SYMBOLS: Record<string, string> = { '%': 'percent', '&': 'and', '+': 'plus', '@': 'at' };
export const US_VOCAB = new Set(Array.from('AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ'));
export const GB_VOCAB = new Set(Array.from('AIQWYabdfhijklmnpstuvwzðŋɑɒɔəɛɜɡɪɹʃʊʌʒʤʧˈˌːθᵊ'));
const STRESSES = new Set(['ˌ', 'ˈ']);
export const PRIMARY_STRESS = 'ˈ';
export const SECONDARY_STRESS = 'ˌ';
export const VOWELS = new Set(Array.from('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ'));

export interface TokenContext {
  futureVowel: boolean | null;
  futureTo: boolean;
}

export function emptyTokenContext(): TokenContext {
  return { futureVowel: null, futureTo: false };
}

/** A gold entry is one pronunciation, or one per part-of-speech tag. */
export type GoldValue = string | Record<string, string | null>;
export type LexiconResult = [phonemes: string | null, rating: number | null];

const NONE: LexiconResult = [null, null];

const LETTER = /^\p{L}$/u;
const NUMBER = /^\p{N}$/u;
const UPPER = /^\p{Lu}$/u;

export function isLetter(character: string): boolean {
  return LETTER.test(character);
}

export function isNumberCharacter(character: string): boolean {
  return NUMBER.test(character);
}

export function isUppercaseCharacter(character: string): boolean {
  return UPPER.test(character);
}

export function chars(text: string): string[] {
  return Array.from(text);
}

export function stressWeight(phonemes: string | null): number {
  if (phonemes === null) return 0;
  let total = 0;
  for (const character of phonemes) total += DIPHTHONGS.has(character) ? 2 : 1;
  return total;
}

function restress(phonemes: string): string {
  const characters = chars(phonemes);
  const indexed = characters.map((character, index) => ({ position: index, character }));
  characters.forEach((character, index) => {
    if (!STRESSES.has(character)) return;
    for (let vowel = index; vowel < characters.length; vowel += 1) {
      if (VOWELS.has(characters[vowel]!)) {
        indexed[index]!.position = vowel - 0.5;
        break;
      }
    }
  });
  // Array#sort is stable, which is what the reordering relies on.
  return indexed.sort((a, b) => a.position - b.position).map((entry) => entry.character).join('');
}

function hasAny(phonemes: string, set: Set<string>): boolean {
  for (const character of phonemes) if (set.has(character)) return true;
  return false;
}

export function applyStress(phonemes: string | null, stress: number | null): string | null {
  if (phonemes === null) return null;
  if (stress === null) return phonemes;

  if (stress < -1) {
    return chars(phonemes).filter((c) => c !== PRIMARY_STRESS && c !== SECONDARY_STRESS).join('');
  }
  if (stress === -1 || ((stress === 0 || stress === -0.5) && phonemes.includes(PRIMARY_STRESS))) {
    return phonemes.replaceAll(SECONDARY_STRESS, '').replaceAll(PRIMARY_STRESS, SECONDARY_STRESS);
  }
  if (stress === 0 || stress === 0.5 || stress === 1) {
    if (!hasAny(phonemes, STRESSES)) {
      if (!hasAny(phonemes, VOWELS)) return phonemes;
      return restress(SECONDARY_STRESS + phonemes);
    }
    return phonemes;
  }
  if (stress >= 1 && !phonemes.includes(PRIMARY_STRESS) && phonemes.includes(SECONDARY_STRESS)) {
    return phonemes.replaceAll(SECONDARY_STRESS, PRIMARY_STRESS);
  }
  if (stress > 1 && !hasAny(phonemes, STRESSES)) {
    if (!hasAny(phonemes, VOWELS)) return phonemes;
    return restress(PRIMARY_STRESS + phonemes);
  }
  return phonemes;
}

export function isDigitString(text: string): boolean {
  return text.length > 0 && chars(text).every(isNumberCharacter);
}

function splitLowercaseWords(text: string): string[] {
  return text.split(/\P{L}+/u).filter(Boolean);
}

export function isAsciiLetter(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

function isLexiconOrdinalCharacter(character: string): boolean {
  return character === "'" || isAsciiLetter(character);
}

export function isAllUppercase(text: string): boolean {
  return text.length > 0 && text === text.toUpperCase();
}

export function isTitleCaseWord(text: string): boolean {
  const [first, ...rest] = chars(text);
  if (first === undefined) return false;
  const tail = rest.join('');
  return isUppercaseCharacter(first) && tail === tail.toLowerCase();
}

function dropLast(text: string, count = 1): string {
  return chars(text).slice(0, -count).join('');
}

function lastChar(text: string): string | undefined {
  return chars(text).at(-1);
}

/**
 * Adds the capitalised form of every lower-case key and the lower-case form of
 * every capitalised one, as upstream does. Real entries win over the extras.
 */
function growDictionary<T>(dictionary: Record<string, T>): Map<string, T> {
  const grown = new Map<string, T>();
  for (const [key, value] of Object.entries(dictionary)) {
    if (chars(key).length < 2) continue;
    const lower = key.toLowerCase();
    if (key === lower) {
      const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
      if (key !== capitalized) grown.set(capitalized, value);
    } else if (key === lower.charAt(0).toUpperCase() + lower.slice(1)) {
      grown.set(lower, value);
    }
  }
  for (const [key, value] of Object.entries(dictionary)) grown.set(key, value);
  return grown;
}

function variantFor(value: Record<string, string | null>, tag: string): string | null {
  return Object.hasOwn(value, tag) ? value[tag]! : (value.DEFAULT ?? null);
}

export interface LexiconData {
  gold: Record<string, GoldValue>;
  silver: Record<string, string>;
}

export class Lexicon {
  readonly british: boolean;
  private readonly capStresses: [number, number] = [0.5, 2];
  private readonly golds: Map<string, GoldValue>;
  private readonly silvers: Map<string, string>;
  private readonly letterToSound: LetterToSound | null;
  /** Dotted entries ("Mr.", "Dr."): the tokenizer keeps their full stop. */
  readonly abbreviations: ReadonlySet<string>;

  constructor(input: { british: boolean; data: LexiconData; letterToSound: LetterToSound | null }) {
    this.british = input.british;
    this.golds = growDictionary(input.data.gold);
    this.silvers = growDictionary(input.data.silver);
    this.letterToSound = input.letterToSound;
    this.abbreviations = new Set([...this.golds.keys()].filter((key) => key.length > 1 && key.endsWith('.')));
    Lexicon.validate(this.golds, this.british);
  }

  private static validate(golds: Map<string, GoldValue>, british: boolean): void {
    const vocab = british ? GB_VOCAB : US_VOCAB;
    const check = (phonemes: string) => {
      for (const character of phonemes) {
        if (!vocab.has(character)) throw new Error(`Misaki lexicon holds a phoneme outside the vocabulary: ${phonemes}`);
      }
    };
    for (const value of golds.values()) {
      if (typeof value === 'string') {
        check(value);
        continue;
      }
      if (!Object.hasOwn(value, 'DEFAULT')) throw new Error('Misaki lexicon variant is missing DEFAULT');
      for (const phonemes of Object.values(value)) if (phonemes !== null) check(phonemes);
    }
  }

  private goldString(key: string): string | null {
    const value = this.golds.get(key);
    if (value === undefined) return null;
    return typeof value === 'string' ? value : (value.DEFAULT ?? null);
  }

  getNNP(word: string): LexiconResult {
    const pieces: string[] = [];
    for (const character of word) {
      if (!isLetter(character)) continue;
      const phonemes = this.goldString(character.toUpperCase());
      if (phonemes !== null) pieces.push(phonemes);
    }
    if (pieces.length === 0) return NONE;
    const joined = pieces.join('');
    if (!joined) return NONE;
    const stressed = applyStress(joined, 0);
    if (stressed === null) return NONE;
    // Upstream promotes the *last* secondary stress (`rsplit`), which puts an
    // initialism's stress on its final letter: F-B-I. The Swift port split at
    // the first one instead; this follows upstream. See PROVENANCE.md.
    const at = stressed.lastIndexOf(SECONDARY_STRESS);
    const promoted = at < 0 ? stressed : `${stressed.slice(0, at)}${PRIMARY_STRESS}${stressed.slice(at + 1)}`;
    return [promoted, 3];
  }

  private getSpecialCase(word: string, tag: string | null, stress: number | null, ctx: TokenContext): LexiconResult {
    if (tag === 'ADD' && ADD_SYMBOLS[word]) return this.lookup(ADD_SYMBOLS[word]!, null, -0.5, ctx);
    if (Object.hasOwn(SYMBOLS, word)) return this.lookup(SYMBOLS[word]!, null, null, ctx);
    if (
      word.replace(/^\.+|\.+$/g, '').includes('.')
      && chars(word.replaceAll('.', '')).every(isLetter)
      && Math.max(0, ...word.split('.').filter(Boolean).map((part) => chars(part).length)) < 3
    ) {
      return this.getNNP(word);
    }
    if (word === 'a' || word === 'A') return [tag === 'DT' ? 'ɐ' : 'ˈA', 4];
    if (word === 'am' || word === 'Am' || word === 'AM') {
      if ((tag ?? '').startsWith('NN')) return this.getNNP(word);
      if (ctx.futureVowel === null || word !== 'am' || (stress !== null && stress > 0)) {
        return [this.goldString('am'), 4];
      }
      return ['ɐm', 4];
    }
    if (word === 'an' || word === 'An' || word === 'AN') {
      if (word === 'AN' && (tag ?? '').startsWith('NN')) return this.getNNP(word);
      return ['ɐn', 4];
    }
    if (word === 'I' && tag === 'PRP') return [`${SECONDARY_STRESS}I`, 4];
    if ((word === 'by' || word === 'By' || word === 'BY') && Lexicon.parentTag(tag) === 'ADV') return ['bˈI', 4];
    if (word === 'to' || word === 'To' || (word === 'TO' && (tag === 'TO' || tag === 'IN'))) {
      const phonemes = ctx.futureVowel === null
        ? (this.goldString('to') ?? 'tu')
        : ctx.futureVowel ? 'tʊ' : 'tə';
      return [phonemes, 4];
    }
    if (word === 'in' || word === 'In' || (word === 'IN' && tag !== 'NNP')) {
      const marker = ctx.futureVowel === null || tag !== 'IN' ? PRIMARY_STRESS : '';
      return [`${marker}ɪn`, 4];
    }
    if (word === 'the' || word === 'The' || (word === 'THE' && tag === 'DT')) {
      return [ctx.futureVowel === true ? 'ði' : 'ðə', 4];
    }
    if (tag === 'IN' && /^vs\.?$/i.test(word)) return this.lookup('versus', null, null, ctx);
    if (word === 'used' || word === 'Used' || word === 'USED') {
      const used = this.golds.get('used');
      if (used !== undefined && typeof used !== 'string') {
        if ((tag === 'VBD' || tag === 'JJ' || tag === 'VB') && ctx.futureTo) {
          return [Object.hasOwn(used, 'VBD') ? used.VBD! : null, 4];
        }
        return [used.DEFAULT ?? null, 4];
      }
    }
    return NONE;
  }

  static parentTag(tag: string | null): string | null {
    if (tag === null) return null;
    if (tag.startsWith('VB')) return 'VERB';
    if (tag.startsWith('NN')) return 'NOUN';
    if (tag.startsWith('ADV') || tag.startsWith('RB')) return 'ADV';
    if (tag.startsWith('ADJ') || tag.startsWith('JJ')) return 'ADJ';
    return tag;
  }

  isKnown(word: string): boolean {
    if (this.golds.has(word) || Object.hasOwn(SYMBOLS, word) || this.silvers.has(word)) return true;
    const characters = chars(word);
    if (!characters.every(isLexiconOrdinalCharacter)) return false;
    if (characters.length === 1) return true;
    if (isAllUppercase(word) && this.golds.has(word.toLowerCase())) return true;
    const suffix = characters.slice(1).join('');
    return suffix === suffix.toUpperCase();
  }

  lookup(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): LexiconResult {
    let lookupWord = word;
    let properNameGuess: boolean | null = null;
    if (isAllUppercase(lookupWord) && !this.golds.has(lookupWord)) {
      lookupWord = lookupWord.toLowerCase();
      properNameGuess = tag === 'NNP';
    }

    let phonemes: string | null = null;
    let rating = 4;
    const gold = this.golds.get(lookupWord);
    if (typeof gold === 'string') {
      phonemes = gold;
    } else if (gold !== undefined) {
      let selectedTag = tag;
      if (ctx !== null && ctx.futureVowel === null && Object.hasOwn(gold, 'None')) {
        selectedTag = 'None';
      } else if (selectedTag !== null && !Object.hasOwn(gold, selectedTag)) {
        selectedTag = Lexicon.parentTag(selectedTag);
      }
      phonemes = variantFor(gold, selectedTag ?? 'DEFAULT');
    }

    if (phonemes === null && properNameGuess !== true) {
      phonemes = this.silvers.get(lookupWord) ?? null;
      if (phonemes !== null) rating = 3;
    }

    if (phonemes === null || (properNameGuess === true && !phonemes.includes(PRIMARY_STRESS))) {
      const proper = this.getNNP(lookupWord);
      if (proper[0] !== null) return proper;
    }

    return [applyStress(phonemes, stress), phonemes === null ? null : rating];
  }

  pluralSuffix(stem: string | null): string | null {
    const last = stem === null ? undefined : lastChar(stem);
    if (stem === null || last === undefined) return null;
    if ('ptkfθ'.includes(last)) return `${stem}s`;
    if ('szʃʒʧʤ'.includes(last)) return `${stem}${this.british ? 'ɪ' : 'ᵻ'}z`;
    return `${stem}z`;
  }

  private stemS(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): LexiconResult {
    if (chars(word).length < 3 || !word.endsWith('s')) return NONE;
    const length = chars(word).length;
    let stem: string | null = null;
    if (!word.endsWith('ss') && this.isKnown(dropLast(word))) {
      stem = dropLast(word);
    } else if (
      (word.endsWith("'s") || (length > 4 && word.endsWith('es') && !word.endsWith('ies')))
      && this.isKnown(dropLast(word, 2))
    ) {
      stem = dropLast(word, 2);
    } else if (length > 4 && word.endsWith('ies') && this.isKnown(`${dropLast(word, 3)}y`)) {
      stem = `${dropLast(word, 3)}y`;
    }
    if (stem === null) return NONE;
    const [stemPhonemes, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.pluralSuffix(stemPhonemes), rating];
  }

  edSuffix(stem: string | null): string | null {
    const last = stem === null ? undefined : lastChar(stem);
    if (stem === null || last === undefined) return null;
    if ('pkfθʃsʧ'.includes(last)) return `${stem}t`;
    if (last === 'd') return `${stem}${this.british ? 'ɪ' : 'ᵻ'}d`;
    if (last !== 't') return `${stem}d`;
    const characters = chars(stem);
    if (this.british || characters.length < 2) return `${stem}ɪd`;
    if (US_TAUS.has(characters[characters.length - 2]!)) return `${characters.slice(0, -1).join('')}ɾᵻd`;
    return `${stem}ᵻd`;
  }

  private stemED(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): LexiconResult {
    const length = chars(word).length;
    if (length < 4 || !word.endsWith('d')) return NONE;
    let stem: string | null = null;
    if (!word.endsWith('dd') && this.isKnown(dropLast(word))) {
      stem = dropLast(word);
    } else if (length > 4 && word.endsWith('ed') && !word.endsWith('eed') && this.isKnown(dropLast(word, 2))) {
      stem = dropLast(word, 2);
    }
    if (stem === null) return NONE;
    const [stemPhonemes, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.edSuffix(stemPhonemes), rating];
  }

  ingSuffix(stem: string | null): string | null {
    const last = stem === null ? undefined : lastChar(stem);
    if (stem === null || last === undefined) return null;
    const characters = chars(stem);
    if (this.british) {
      if (last === 'ə' || last === 'ː') return null;
    } else if (characters.length > 1 && last === 't' && US_TAUS.has(characters[characters.length - 2]!)) {
      return `${characters.slice(0, -1).join('')}ɾɪŋ`;
    }
    return `${stem}ɪŋ`;
  }

  private stemING(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): LexiconResult {
    const length = chars(word).length;
    if (length < 5 || !word.endsWith('ing')) return NONE;
    const base = dropLast(word, 3);
    let stem: string | null = null;
    if (length > 5 && this.isKnown(base)) {
      stem = base;
    } else if (this.isKnown(`${base}e`)) {
      stem = `${base}e`;
    } else if (length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) && this.isKnown(dropLast(word, 4))) {
      stem = dropLast(word, 4);
    }
    if (stem === null) return NONE;
    const [stemPhonemes, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.ingSuffix(stemPhonemes), rating];
  }

  private getWord(word: string, tag: string | null, stress: number | null, ctx: TokenContext): LexiconResult {
    const special = this.getSpecialCase(word, tag, stress, ctx);
    if (special[0] !== null) return special;

    let lookupWord = word;
    const lowercased = word.toLowerCase();
    const deapostrophized = word.replaceAll("'", '');
    const tail = chars(word).slice(1).join('');
    if (
      chars(word).length > 1
      && deapostrophized.length > 0
      && chars(deapostrophized).every(isLetter)
      && word !== lowercased
      && (tag !== 'NNP' || chars(word).length > 7)
      && !this.golds.has(word)
      && !this.silvers.has(word)
      && (isAllUppercase(word) || tail === tail.toLowerCase())
      && (
        this.golds.has(lowercased)
        || this.silvers.has(lowercased)
        || this.stemS(lowercased, tag, stress, ctx)[0] !== null
        || this.stemED(lowercased, tag, stress, ctx)[0] !== null
        || this.stemING(lowercased, tag, stress, ctx)[0] !== null
      )
    ) {
      lookupWord = lowercased;
    }

    if (this.isKnown(lookupWord)) return this.lookup(lookupWord, tag, stress, ctx);
    if (lookupWord.endsWith("s'") && this.isKnown(`${dropLast(lookupWord, 2)}'s`)) {
      return this.lookup(`${dropLast(lookupWord, 2)}'s`, tag, stress, ctx);
    }
    if (lookupWord.endsWith("'") && this.isKnown(dropLast(lookupWord))) {
      return this.lookup(dropLast(lookupWord), tag, stress, ctx);
    }

    const s = this.stemS(lookupWord, tag, stress, ctx);
    if (s[0] !== null) return s;
    const ed = this.stemED(lookupWord, tag, stress, ctx);
    if (ed[0] !== null) return ed;
    const ing = this.stemING(lookupWord, tag, stress ?? 0.5, ctx);
    if (ing[0] !== null) return ing;
    return NONE;
  }

  static isCurrency(word: string): boolean {
    if (!word.includes('.')) return true;
    if (word.split('.').length - 1 > 1) return false;
    const cents = word.split('.')[1] ?? '';
    return chars(cents).length < 3 || (cents.length > 0 && new Set(chars(cents)).size === 1 && cents[0] === '0');
  }

  private getNumber(word: string, currency: string | null, isHead: boolean, numFlags: string): LexiconResult {
    const suffixMatch = /[a-z']+$/i.exec(word);
    const suffix = suffixMatch?.[0] ?? null;
    const suffixLower = suffix?.toLowerCase() ?? null;
    let workingWord = suffix === null ? word : word.slice(0, word.length - suffix.length);
    const result: Array<[string, number]> = [];

    const pushLookup = (text: string, stress: number | null) => {
      const [phonemes, rating] = this.lookup(text, null, stress, null);
      if (phonemes !== null && rating !== null) result.push([phonemes, rating]);
    };

    if (workingWord.startsWith('-')) {
      pushLookup('minus', null);
      workingWord = workingWord.slice(1);
    }

    const appendWord = (text: string, first: boolean, escape = false) => {
      const source = escape ? text : (NumberToWords.cardinalText(text) ?? text);
      const splits = splitLowercaseWords(source);
      splits.forEach((split, index) => {
        if (split !== 'and' || numFlags.includes('&')) {
          if (first && index === 0 && splits.length > 1 && split === 'one' && numFlags.includes('a')) {
            result.push(['ə', 4]);
          } else {
            pushLookup(split, split === 'point' ? -2 : null);
          }
        } else if (split === 'and' && numFlags.includes('n') && result.length > 0) {
          const last = result.pop()!;
          result.push([`${last[0]}ən`, last[1]]);
        }
      });
    };

    if (isDigitString(workingWord) && suffixLower !== null && ORDINALS.has(suffixLower)) {
      appendWord(NumberToWords.ordinalText(workingWord) ?? workingWord, true, true);
    } else if (result.length === 0 && chars(workingWord).length === 4 && currency === null && isDigitString(workingWord)) {
      appendWord(NumberToWords.yearText(workingWord) ?? workingWord, true, true);
    } else if (!isHead && !workingWord.includes('.')) {
      const compact = workingWord.replaceAll(',', '');
      if (compact.startsWith('0') || chars(compact).length > 3) {
        for (const digit of chars(compact)) appendWord(digit, false);
      } else if (chars(compact).length === 3 && !compact.endsWith('00')) {
        appendWord(chars(compact)[0]!, true);
        const tensAndOnes = chars(compact).slice(1).join('');
        if (tensAndOnes.startsWith('0')) {
          pushLookup('O', -2);
          appendWord(chars(tensAndOnes).at(-1)!, false);
        } else {
          appendWord(tensAndOnes, false);
        }
      } else {
        appendWord(compact, true);
      }
    } else if (workingWord.split('.').length - 1 > 1 || !isHead) {
      let first = true;
      for (const chunk of workingWord.replaceAll(',', '').split('.')) {
        if (!chunk) continue;
        const chunkChars = chars(chunk);
        if (chunk.startsWith('0') || (chunkChars.length !== 2 && chunkChars.slice(1).some((c) => c !== '0'))) {
          for (const digit of chunkChars) appendWord(digit, false);
        } else {
          appendWord(chunk, first);
        }
        first = false;
      }
    } else if (currency !== null && CURRENCIES[currency] && Lexicon.isCurrency(workingWord)) {
      const units = CURRENCIES[currency]!;
      const pairs = workingWord.replaceAll(',', '').split('.');
      while (pairs.length < 2) pairs.push('');
      let quantities: Array<[bigint, string]> = [
        [parseIntOrZero(pairs[0]!), units[0]],
        [parseIntOrZero(pairs[1]!), units[1]],
      ];
      if (quantities[1]![0] === BigInt(0)) quantities = [quantities[0]!];
      else if (quantities[0]![0] === BigInt(0)) quantities = [quantities[1]!];
      quantities.forEach(([amount, unit], index) => {
        if (index > 0) pushLookup('and', null);
        appendWord(amount.toString(), index === 0);
        if ((amount < BigInt(0) ? -amount : amount) !== BigInt(1) && unit !== 'pence') {
          const [phonemes, rating] = this.stemS(`${unit}s`, null, null, null);
          if (phonemes !== null && rating !== null) result.push([phonemes, rating]);
        } else {
          pushLookup(unit, null);
        }
      });
    } else {
      let spoken: string;
      if (isDigitString(workingWord)) {
        spoken = NumberToWords.cardinalText(workingWord) ?? workingWord;
      } else if (!workingWord.includes('.')) {
        const compact = workingWord.replaceAll(',', '');
        const ordinal = suffixLower !== null && ORDINALS.has(suffixLower);
        spoken = (ordinal ? NumberToWords.ordinalText(compact) : NumberToWords.cardinalText(compact))
          ?? NumberToWords.cardinalText(compact)
          ?? compact;
      } else {
        const compact = workingWord.replaceAll(',', '');
        const digits = (text: string) => chars(text).map((c) => NumberToWords.cardinalText(c) ?? c).join(' ');
        if (compact.startsWith('.')) {
          spoken = `point ${digits(compact.slice(1))}`;
        } else {
          const parts = compact.split('.');
          const left = NumberToWords.cardinalText(parts[0]!) ?? parts[0]!;
          const right = parts.length > 1 ? digits(parts[1]!) : '';
          spoken = right ? `${left} point ${right}` : left;
        }
      }
      appendWord(spoken, true, true);
    }

    if (result.length === 0) return NONE;
    const phonemes = result.map(([p]) => p).join(' ');
    const rating = Math.min(...result.map(([, r]) => r));
    if (suffixLower === 's' || suffixLower === "'s") return [this.pluralSuffix(phonemes), rating];
    if (suffixLower === 'ed' || suffixLower === "'d") return [this.edSuffix(phonemes), rating];
    if (suffixLower === 'ing') return [this.ingSuffix(phonemes), rating];
    return [phonemes, rating];
  }

  private appendCurrency(phonemes: string, currency: string | null): string {
    if (currency === null) return phonemes;
    const unit = CURRENCIES[currency]?.[0];
    if (!unit) return phonemes;
    const pluralized = this.stemS(`${unit}s`, null, null, null)[0];
    return pluralized === null ? phonemes : `${phonemes} ${pluralized}`;
  }

  static isNumber(word: string, isHead: boolean): boolean {
    if (!chars(word).some(isNumberCharacter)) return false;
    const suffixes = ['ing', "'d", 'ed', "'s", 'st', 'nd', 'rd', 'th', 's'];
    let candidate = word;
    const lower = candidate.toLowerCase();
    const suffix = suffixes.find((s) => lower.endsWith(s));
    if (suffix) candidate = candidate.slice(0, candidate.length - suffix.length);
    return chars(candidate).every((character, index) => (
      isNumberCharacter(character)
      || character === ','
      || character === '.'
      || (isHead && index === 0 && character === '-')
    ));
  }

  /** Phonemes and a confidence rating for one token, or `[null, null]`. */
  resolve(token: MToken, ctx: TokenContext): LexiconResult {
    // An alias can be a phrase: "mph" is said "miles per hour".
    const alias = token._.alias;
    if (alias !== null && alias.includes(' ')) {
      const parts: string[] = [];
      for (const piece of alias.split(' ').filter(Boolean)) {
        const sub = cloneToken(token);
        sub._.alias = piece;
        const resolved = this.resolve(sub, ctx)[0];
        if (resolved === null) return NONE;
        parts.push(resolved);
      }
      return [parts.join(' '), 4];
    }

    let word = (alias ?? token.text).replaceAll('‘', "'").replaceAll('’', "'");
    word = word.normalize('NFKC');
    word = chars(word).map(asciiDigit).join('');

    const stress = word === word.toLowerCase()
      ? null
      : isAllUppercase(word) ? this.capStresses[1] : this.capStresses[0];

    const [wordPhonemes, wordRating] = this.getWord(word, token.tag, stress, ctx);
    if (wordPhonemes !== null) {
      return [applyStress(this.appendCurrency(wordPhonemes, token._.currency), token._.stress), wordRating];
    }

    if (Lexicon.isNumber(word, token._.isHead)) {
      const [numberPhonemes, numberRating] = this.getNumber(word, token._.currency, token._.isHead, token._.numFlags);
      return [applyStress(numberPhonemes, token._.stress), numberRating];
    }

    // Before guessing from spelling, try the lexicon without diacritics:
    // "café" is absent and "cafe" present. Only after a straight lookup
    // failed, so nothing that already resolved can change.
    const folded = word.normalize('NFD').replace(/\p{Mn}+/gu, '').normalize('NFC');
    if (folded !== word) {
      const [foldedPhonemes, foldedRating] = this.getWord(folded, token.tag, stress, ctx);
      if (foldedPhonemes !== null) {
        return [applyStress(this.appendCurrency(foldedPhonemes, token._.currency), token._.stress), foldedRating];
      }
    }

    // Neither dictionary holds it. Guess from the spelling (where upstream
    // calls espeak) rather than let the word vanish. A possessive on an
    // unknown name keeps its ending through the known-word suffix rule.
    let base = word;
    let reattach: ((stem: string) => string | null) | null = null;
    const lowered = word.toLowerCase();
    const length = chars(word).length;
    if (length > 2 && (lowered.endsWith("'s") || lowered.endsWith('’s'))) {
      base = dropLast(word, 2);
      reattach = (stem) => this.pluralSuffix(stem);
    } else if (length > 1 && (lowered.endsWith("'") || lowered.endsWith('’'))) {
      base = dropLast(word);
    }
    const guessed = this.letterToSound?.guess(base) ?? null;
    const withEnding = guessed === null ? null : (reattach ? reattach(guessed) : guessed);
    if (withEnding) {
      return [applyStress(this.appendCurrency(withEnding, token._.currency), token._.stress), 1];
    }
    return NONE;
  }
}

function parseIntOrZero(text: string): bigint {
  return /^[+-]?\d+$/.test(text) ? BigInt(text) : BigInt(0);
}

/** Swift's `numericIfNeeded`: a decimal digit in any script becomes ASCII. */
function asciiDigit(character: string): string {
  if (!/^\p{Nd}$/u.test(character)) return character;
  const value = Number.parseInt(character, 10);
  if (Number.isInteger(value)) return String(value);
  // Non-ASCII decimal digits: Unicode lays each script's digits out as a
  // contiguous run starting at a code point whose value mod 16 is 0 or 6.
  const code = character.codePointAt(0)!;
  for (let zero = code; zero > code - 10; zero -= 1) {
    if (!/^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) return String(code - zero);
  }
  return character;
}
