/**
 * TypeScript port of Misaki's English `G2P`, from the OpenReader iOS port
 * (vendored from kokoro-swift, a port of hexgrad/misaki). Apache-2.0; see
 * ../assets/LICENSE.txt. The iOS fixes — possessive glue, intra-word hyphens,
 * symbol words, unit abbreviations, diacritic folding and letter-to-sound in
 * place of espeak — are kept, and their reasoning is recorded beside each.
 * `tagger.ts` stands in for `NLTagger`.
 */

import {
  CONSONANTS,
  CURRENCIES,
  type Lexicon,
  NON_QUOTE_PUNCTS,
  PRIMARY_STRESS,
  PUNCT_TAG_PHONEMES,
  PUNCT_TAGS,
  PUNCTS,
  SUBTOKEN_JUNKS,
  SYMBOLS,
  type TokenContext,
  VOWELS,
  applyStress,
  chars,
  emptyTokenContext,
  isAsciiLetter,
  stressWeight,
} from './lexicon';
import { tagText } from './tagger';
import { cloneToken, createToken, createUnderscore, type MToken } from './token';

type TokenUnit = { kind: 'token'; token: MToken } | { kind: 'group'; tokens: MToken[] };

type FeatureKind =
  | { kind: 'stress'; value: number }
  | { kind: 'phonemeOverride'; value: string }
  | { kind: 'numFlags'; value: string };

interface FeatureSpan {
  start: number;
  end: number;
  feature: FeatureKind;
}

const SUBTOKEN_REGEX = /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\p{Nd}?[,.]?\p{Nd})+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^\-_\p{L}'‘’\p{Nd}]|['‘’]+$/gu;
const LINK_REGEX = /\[([^\]]+)\]\(([^)]*)\)/g;
const LETTER = /^\p{L}$/u;
const NUMBER = /^\p{N}$/u;

const isLetter = (character: string | undefined) => character !== undefined && LETTER.test(character);
const isNumber = (character: string | undefined) => character !== undefined && NUMBER.test(character);
const allJunk = (text: string) => chars(text).every((c) => SUBTOKEN_JUNKS.has(c));

function caseWeight(text: string): number {
  let total = 0;
  for (const character of text) total += /\p{Lu}/u.test(character) ? 2 : 1;
  return total;
}

function joinedText(tokens: MToken[]): string {
  return tokens.map((token, index) => (index < tokens.length - 1 ? token.text + token.whitespace : token.text)).join('');
}

export function mergeTokens(tokens: MToken[], unk: string | null = null): MToken {
  const stresses = new Set(tokens.map((t) => t._.stress).filter((s): s is number => s !== null));
  const currencies = tokens.map((t) => t._.currency).filter((c): c is string => c !== null);
  const ratings = tokens.map((t) => t._.rating);

  let phonemes: string | null = null;
  if (unk !== null) {
    let merged = '';
    for (const token of tokens) {
      if (token._.prespace && merged && !/\s$/u.test(merged) && token.phonemes) merged += ' ';
      merged += token.phonemes ?? unk;
    }
    phonemes = merged;
  }

  let chosen: MToken | undefined;
  for (const token of tokens) {
    if (chosen === undefined || caseWeight(chosen.text) < caseWeight(token.text)) chosen = token;
  }

  return {
    text: joinedText(tokens),
    tag: chosen?.tag ?? '',
    whitespace: tokens.at(-1)?.whitespace ?? '',
    phonemes,
    _: createUnderscore({
      isHead: tokens[0]?._.isHead ?? true,
      stress: stresses.size === 1 ? [...stresses][0]! : null,
      currency: currencies.length ? currencies.reduce((a, b) => (b > a ? b : a)) : null,
      numFlags: [...new Set(tokens.flatMap((t) => chars(t._.numFlags)))].sort().join(''),
      prespace: tokens[0]?._.prespace ?? false,
      rating: ratings.includes(null) ? null : Math.min(...(ratings as number[])),
    }),
  };
}

function parseFeature(feature: string): FeatureKind | null {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(feature)) {
    return { kind: 'stress', value: Number(feature) };
  }
  const length = chars(feature).length;
  if (length > 1 && feature.startsWith('/') && feature.endsWith('/')) {
    return { kind: 'phonemeOverride', value: feature.slice(1, -1) };
  }
  if (length > 1 && feature.startsWith('#') && feature.endsWith('#')) {
    return { kind: 'numFlags', value: feature.slice(1, -1) };
  }
  return null;
}

/** Straight and curly alike: Word exports use U+2019 for every apostrophe. */
function isApostrophe(character: string | undefined): boolean {
  return character === "'" || character === '’' || character === '‘';
}

/**
 * Unit abbreviations and what a reader says for them. Single letters are
 * left out deliberately: after a number "m" is metres or millions, so
 * guessing costs more than the spelling it would replace.
 */
const UNIT_WORDS: Record<string, [one: string, many: string]> = {
  kg: ['kilogram', 'kilograms'], kgs: ['kilograms', 'kilograms'],
  mg: ['milligram', 'milligrams'], km: ['kilometer', 'kilometers'],
  cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'],
  ml: ['milliliter', 'milliliters'],
  lb: ['pound', 'pounds'], lbs: ['pounds', 'pounds'],
  oz: ['ounce', 'ounces'], ft: ['foot', 'feet'],
  yd: ['yard', 'yards'], yds: ['yards', 'yards'],
  mi: ['mile', 'miles'],
  mph: ['miles per hour', 'miles per hour'],
  kph: ['kilometers per hour', 'kilometers per hour'],
  hr: ['hour', 'hours'], hrs: ['hours', 'hours'],
  min: ['minute', 'minutes'], mins: ['minutes', 'minutes'],
  sec: ['second', 'seconds'], secs: ['seconds', 'seconds'],
  yr: ['year', 'years'], yrs: ['years', 'years'],
  kb: ['kilobyte', 'kilobytes'], mb: ['megabyte', 'megabytes'],
  gb: ['gigabyte', 'gigabytes'], tb: ['terabyte', 'terabytes'],
};

function unitReading(text: string, number: string | null): string | null {
  if (number === null) return null;
  const entry = UNIT_WORDS[text.toLowerCase()];
  if (!entry) return null;
  return number === '1' ? entry[0] : entry[1];
}

/** The number a unit follows, written against it ("1.2kg") or spaced ("5 km"). */
function precedingNumber(pieces: MToken[], pieceIndex: number, tokens: MToken[], tokenIndex: number): string | null {
  const previous = pieceIndex > 0
    ? pieces[pieceIndex - 1]!.text
    : tokenIndex > 0 ? tokens[tokenIndex - 1]!.text : null;
  if (previous === null || !isNumber(chars(previous).at(-1))) return null;
  return previous;
}

function subtokenize(word: string): string[] {
  return Array.from(word.matchAll(SUBTOKEN_REGEX), (match) => match[0]);
}

export interface G2PResult {
  phonemes: string;
  tokens: MToken[];
}

export class G2P {
  readonly lexicon: Lexicon;
  readonly unk: string;
  readonly version: string | null;

  constructor(input: { lexicon: Lexicon; unk?: string; version?: string | null }) {
    this.lexicon = input.lexicon;
    this.unk = input.unk ?? '❓';
    this.version = input.version ?? null;
  }

  get british(): boolean {
    return this.lexicon.british;
  }

  static preprocess(text: string): { text: string; features: FeatureSpan[] } {
    const trimmed = text.replace(/^\s+/u, '');
    let result = '';
    const features: FeatureSpan[] = [];
    let current = 0;
    for (const match of trimmed.matchAll(LINK_REGEX)) {
      result += trimmed.slice(current, match.index);
      const start = result.length;
      result += match[1]!;
      const feature = parseFeature(match[2]!);
      if (feature !== null) features.push({ start, end: result.length, feature });
      current = match.index + match[0].length;
    }
    result += trimmed.slice(current);
    return { text: result, features };
  }

  tokenize(text: string, features: FeatureSpan[] = []): MToken[] {
    let slices = tagText(text, this.lexicon.abbreviations);

    // Glue an apostrophe back onto the word it touches, taking a following
    // "s" with it, so a possessive is looked up whole rather than read as the
    // letter S. A bare apostrophe joins only an s-final word: that takes every
    // plural possessive ("the boys' room") and leaves "'stop'" its closing
    // quote. An opening quote never touches a word on its left.
    const glued: typeof slices = [];
    for (const slice of slices) {
      const piece = text.slice(slice.start, slice.end);
      const previous = glued.at(-1);
      if (previous !== undefined && previous.end === slice.start) {
        const previousText = text.slice(previous.start, previous.end);
        const apostropheLed = isApostrophe(chars(piece)[0]);
        const bareApostrophe = apostropheLed && chars(piece).every(isApostrophe);
        const closesPossessive = bareApostrophe && previousText.toLowerCase().endsWith('s');
        const possessiveS = piece.toLowerCase() === 's' && isApostrophe(chars(previousText).at(-1));
        if ((apostropheLed && !bareApostrophe) || closesPossessive || possessiveS) {
          glued[glued.length - 1] = { start: previous.start, end: slice.end, tag: previous.tag };
          continue;
        }
      }
      glued.push(slice);
    }
    slices = glued;

    // spaCy tags a hyphen inside a compound `HYPH` and a free-standing dash
    // `:`, which Misaki speaks as an em dash. Restore that line from what the
    // hyphen touches: flanked on both sides with no space, with a letter on at
    // least one side, it is part of a word ("well-known"); "1939-1945",
    // "paused - then" and "--" keep the pause.
    for (let index = 1; index + 1 < slices.length; index += 1) {
      const slice = slices[index]!;
      const piece = text.slice(slice.start, slice.end);
      if (piece !== '-' && piece !== '–') continue;
      const left = slices[index - 1]!;
      const right = slices[index + 1]!;
      if (left.end !== slice.start || slice.end !== right.start) continue;
      const leftChar = chars(text.slice(left.start, left.end)).at(-1);
      const rightChar = chars(text.slice(right.start, right.end))[0];
      if (!(isLetter(leftChar) || isNumber(leftChar)) || !(isLetter(rightChar) || isNumber(rightChar))) continue;
      if (!isLetter(leftChar) && !isLetter(rightChar)) continue;
      slices[index] = { ...slice, tag: 'HYPH' };
    }

    const tokens = slices.map((slice, index) => createToken({
      text: text.slice(slice.start, slice.end),
      tag: slice.tag,
      whitespace: text.slice(slice.end, index + 1 < slices.length ? slices[index + 1]!.start : text.length),
    }));

    for (const span of features) {
      const indices = slices
        .map((slice, index) => (slice.start < span.end && slice.end > span.start ? index : -1))
        .filter((index) => index >= 0);
      const { feature } = span;
      indices.forEach((index, offset) => {
        const token = tokens[index]!;
        if (feature.kind === 'stress') {
          token._.stress = feature.value;
        } else if (feature.kind === 'phonemeOverride') {
          token._.isHead = offset === 0;
          token.phonemes = offset === 0 ? feature.value : '';
          token._.rating = 5;
        } else {
          token._.numFlags = feature.value;
        }
      });
    }
    return tokens;
  }

  foldLeft(tokens: MToken[]): MToken[] {
    const result: MToken[] = [];
    for (const token of tokens) {
      const last = result.at(-1);
      if (last !== undefined && !token._.isHead) {
        result.pop();
        result.push(mergeTokens([last, token], this.unk));
      } else {
        result.push(token);
      }
    }
    return result;
  }

  static retokenize(tokens: MToken[]): TokenUnit[] {
    const words: TokenUnit[] = [];
    let currentCurrency: string | null = null;

    const appendStandalone = (token: MToken) => words.push({ kind: 'token', token });
    const appendOrdinary = (token: MToken) => {
      const last = words.at(-1);
      if (last?.kind === 'group' && last.tokens.at(-1)?.whitespace === '') {
        token._.isHead = false;
        last.tokens.push(token);
      } else if (token.whitespace === '') {
        words.push({ kind: 'group', tokens: [token] });
      } else {
        words.push({ kind: 'token', token });
      }
    };

    tokens.forEach((token, tokenIndex) => {
      const pieces = token._.alias === null && token.phonemes === null
        ? subtokenize(token.text).map((piece) => createToken({
          text: piece,
          tag: token.tag,
          whitespace: '',
          underscore: { stress: token._.stress, numFlags: token._.numFlags },
        }))
        : [token];
      if (pieces.length === 0) return;
      pieces.at(-1)!.whitespace = token.whitespace;

      pieces.forEach((piece, pieceIndex) => {
        if (piece._.alias !== null || piece.phonemes !== null) {
          appendStandalone(piece);
          return;
        }
        if (piece.tag === '$' && Object.hasOwn(CURRENCIES, piece.text)) {
          currentCurrency = piece.text;
          piece.phonemes = '';
          piece._.rating = 4;
          appendStandalone(piece);
          return;
        }
        // An intra-word hyphen joins the halves of a compound: spoken as
        // nothing, so the two run together.
        if (piece.tag === 'HYPH') {
          piece.phonemes = '';
          piece._.rating = 4;
          appendStandalone(piece);
          return;
        }
        if (piece.tag === ':' && (piece.text === '-' || piece.text === '–')) {
          piece.phonemes = '—';
          piece._.rating = 3;
          appendStandalone(piece);
          return;
        }
        // `&`, `%`, `+` and `@` are words the lexicon holds. Treated as
        // punctuation they would keep only Kokoro-vocab characters, of which
        // they have none, and vanish.
        if (
          PUNCT_TAGS.has(piece.tag)
          && !Object.hasOwn(SYMBOLS, piece.text)
          && !chars(piece.text).every(isAsciiLetter)
        ) {
          piece.phonemes = PUNCT_TAG_PHONEMES[piece.tag] ?? chars(piece.text).filter((c) => PUNCTS.has(c)).join('');
          piece._.rating = 4;
          appendStandalone(piece);
          return;
        }
        // A unit abbreviation after a number is said in full ("20 ft" is
        // "twenty feet"); standing alone it is likelier a word or a name.
        const unit = unitReading(piece.text, precedingNumber(pieces, pieceIndex, tokens, tokenIndex));
        if (unit !== null) piece._.alias = unit;

        if (currentCurrency !== null) {
          if (piece.tag !== 'CD') {
            currentCurrency = null;
          } else if (
            pieceIndex + 1 === pieces.length
            && (tokenIndex + 1 === tokens.length || tokens[tokenIndex + 1]!.tag !== 'CD')
          ) {
            piece._.currency = currentCurrency;
          }
        }

        if (
          pieceIndex > 0
          && pieceIndex + 1 < pieces.length
          && piece.text === '2'
          && isLetter(chars(pieces[pieceIndex - 1]!.text).at(-1))
          && isLetter(chars(pieces[pieceIndex + 1]!.text)[0])
        ) {
          piece._.alias = 'to';
        }

        if (piece._.alias !== null || piece.phonemes !== null) appendStandalone(piece);
        else appendOrdinary(piece);
      });
    });

    return words.map((unit) => (unit.kind === 'group' && unit.tokens.length === 1
      ? { kind: 'token', token: unit.tokens[0]! }
      : unit));
  }

  static tokenContext(ctx: TokenContext, phonemes: string | null, token: MToken): TokenContext {
    let vowel = ctx.futureVowel;
    if (phonemes !== null) {
      for (const character of phonemes) {
        if (VOWELS.has(character) || CONSONANTS.has(character) || NON_QUOTE_PUNCTS.has(character)) {
          vowel = NON_QUOTE_PUNCTS.has(character) ? null : VOWELS.has(character);
          break;
        }
      }
    }
    const futureTo = token.text === 'to' || token.text === 'To'
      || (token.text === 'TO' && (token.tag === 'TO' || token.tag === 'IN'));
    return { futureVowel: vowel, futureTo };
  }

  static resolveTokens(tokens: MToken[]): void {
    const text = joinedText(tokens);
    const categories = new Set(
      chars(text)
        .filter((c) => !SUBTOKEN_JUNKS.has(c))
        .map((c) => (isLetter(c) ? 0 : isNumber(c) ? 1 : 2)),
    );
    const prespace = text.includes(' ') || text.includes('/') || categories.size > 1;

    tokens.forEach((token, index) => {
      if (token.phonemes === null) {
        const only = chars(token.text);
        if (index === tokens.length - 1 && only.length === 1 && NON_QUOTE_PUNCTS.has(only[0]!)) {
          token.phonemes = token.text;
          token._.rating = 3;
        } else if (allJunk(token.text)) {
          token.phonemes = '';
          token._.rating = 3;
        }
      } else if (index > 0) {
        token._.prespace = prespace;
      }
    });

    if (prespace) return;

    const indices: Array<[primary: boolean, weight: number, index: number]> = [];
    tokens.forEach((token, index) => {
      if (token.phonemes) indices.push([token.phonemes.includes(PRIMARY_STRESS), stressWeight(token.phonemes), index]);
    });

    if (indices.length === 2 && chars(tokens[indices[0]![2]]!.text).length === 1) {
      const second = tokens[indices[1]![2]]!;
      second.phonemes = applyStress(second.phonemes, -0.5);
      return;
    }
    if (indices.length < 2 || indices.filter(([primary]) => primary).length <= Math.floor((indices.length + 1) / 2)) {
      return;
    }
    const sorted = [...indices].sort((a, b) => {
      if (a[0] !== b[0]) return a[0] ? 1 : -1;
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[2] - b[2];
    });
    for (const [, , index] of sorted.slice(0, Math.floor(indices.length / 2))) {
      tokens[index]!.phonemes = applyStress(tokens[index]!.phonemes, -0.5);
    }
  }

  phonemize(text: string, options: { preprocess?: boolean } = {}): G2PResult {
    const prepared = options.preprocess === false ? { text, features: [] } : G2P.preprocess(text);
    const tokens = this.foldLeft(this.tokenize(prepared.text, prepared.features));
    const units = G2P.retokenize(tokens);
    let ctx = emptyTokenContext();

    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index]!;
      if (unit.kind === 'token') {
        const { token } = unit;
        if (token.phonemes === null) {
          const [phonemes, rating] = this.lexicon.resolve(cloneToken(token), ctx);
          token.phonemes = phonemes;
          token._.rating = rating;
        }
        ctx = G2P.tokenContext(ctx, token.phonemes, token);
        continue;
      }

      const group = unit.tokens;
      let left = 0;
      let right = group.length;
      while (left < right) {
        const slice = group.slice(left, right);
        const combined = slice.some((t) => t._.alias !== null || t.phonemes !== null) ? null : mergeTokens(slice);
        const [phonemes, rating] = combined === null ? [null, null] : this.lexicon.resolve(combined, ctx);
        if (phonemes !== null) {
          group[left]!.phonemes = phonemes;
          group[left]!._.rating = rating;
          for (const token of group.slice(left + 1, right)) {
            token.phonemes = '';
            token._.rating = rating;
          }
          ctx = G2P.tokenContext(ctx, phonemes, combined!);
          right = left;
          left = 0;
        } else if (left + 1 < right) {
          left += 1;
        } else {
          right -= 1;
          const token = group[right]!;
          if (token.phonemes === null && allJunk(token.text)) {
            token.phonemes = '';
            token._.rating = 3;
          }
          left = 0;
        }
      }
      G2P.resolveTokens(group);
    }

    const resolved = units.map((unit) => (unit.kind === 'token' ? unit.token : mergeTokens(unit.tokens, this.unk)));
    if (this.version !== '2.0') {
      for (const token of resolved) {
        if (token.phonemes !== null) token.phonemes = token.phonemes.replaceAll('ɾ', 'T').replaceAll('ʔ', 't');
      }
    }
    const phonemes = resolved.map((token) => (token.phonemes ?? this.unk) + token.whitespace).join('');
    return { phonemes, tokens: resolved };
  }
}
