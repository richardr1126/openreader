/**
 * Numbers for the languages `LearnedG2P` reads: Spanish, Italian and
 * Brazilian Portuguese, plus Hindi's Indian numbering system. Port of the
 * OpenReader iOS `RomanceNumbers`.
 *
 * A number becomes groups below 1000, which the table holds as Kokoro's own
 * pipeline (espeak-ng) reads them, and the words between them: scales,
 * separators and units. Separators are not espeak's: it reads "1.000" as
 * "uno punto cero cero cero", so here a dot between groups of three digits is
 * a thousands separator and a comma the decimal point, as these languages
 * write them.
 */

export type LearnedLanguage = 'es' | 'it' | 'pt-br' | 'hi';

/** A group below 1000, read from the table, or a word. */
export type NumberPart = number | string;

interface Words {
  thousand: string;
  thousands: string;
  /** "mil e um" in Portuguese; Spanish and Italian put nothing there. */
  afterThousand(rest: number): string | null;
  /** "One" before a million, where it is shorter than the counting word. */
  one: string;
  million: [string, string];
  billion: [string, string];
  decimal: string;
  point: string;
  percent: string[];
  degrees: string;
  ordinals: { masculine: readonly string[]; feminine: readonly string[] };
}

const SPANISH: Words = {
  thousand: 'mil',
  thousands: 'mil',
  afterThousand: () => null,
  one: 'un',
  million: ['millón', 'millones'],
  billion: ['billón', 'billones'],
  decimal: 'coma',
  point: 'punto',
  percent: ['por', 'ciento'],
  degrees: 'grados',
  ordinals: {
    masculine: ['primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'],
    feminine: ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava', 'novena', 'décima'],
  },
};

const ITALIAN: Words = {
  thousand: 'mille',
  thousands: 'mila',
  afterThousand: () => null,
  one: 'un',
  million: ['milione', 'milioni'],
  billion: ['miliardo', 'miliardi'],
  decimal: 'virgola',
  point: 'punto',
  percent: ['per', 'cento'],
  degrees: 'gradi',
  ordinals: {
    masculine: ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo'],
    feminine: ['prima', 'seconda', 'terza', 'quarta', 'quinta', 'sesta', 'settima', 'ottava', 'nona', 'decima'],
  },
};

const PORTUGUESE: Words = {
  thousand: 'mil',
  thousands: 'mil',
  // "e" joins the thousands to a remainder below 100 or a round hundred.
  afterThousand: (rest) => (rest > 0 && (rest < 100 || rest % 100 === 0) ? 'e' : null),
  one: 'um',
  million: ['milhão', 'milhões'],
  billion: ['bilhão', 'bilhões'],
  decimal: 'vírgula',
  point: 'ponto',
  percent: ['por', 'cento'],
  degrees: 'graus',
  ordinals: {
    masculine: ['primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono', 'décimo'],
    feminine: ['primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava', 'nona', 'décima'],
  },
};

const LANGUAGES: Record<Exclude<LearnedLanguage, 'hi'>, Words> = { es: SPANISH, it: ITALIAN, 'pt-br': PORTUGUESE };

/** Normalize digits for reading, keeping the caller's original token text. */
export function normalizeHindiDigits(token: string): string {
  return token.replace(/[०-९]/gu, (digit) => String(digit.codePointAt(0)! - 0x0966));
}

function hindiCardinal(digits: string): NumberPart[] {
  if (digits.length > 1 && digits.startsWith('0')) return Array.from(digits, Number);
  if (digits.length > 15) return Array.from(digits, Number);
  const n = Number(digits);
  if (n < 1000) return [n];
  const out: NumberPart[] = [];
  let rest = n;
  for (const [size, word] of [[10_000_000, 'करोड़'], [100_000, 'लाख'], [1000, 'हज़ार']] as const) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (count) out.push(...hindiCardinal(String(count)), word);
  }
  if (rest) out.push(rest);
  return out;
}

function hindiParts(token: string): NumberPart[] | null {
  const normalized = normalizeHindiDigits(token);
  const match = /^(\d+(?:,\d+)*(?:\.\d+)?)([%°]?)$/u.exec(normalized);
  if (!match) return null;
  const [, value, suffix] = match;
  const [integer, fraction] = value!.split('.');
  if (integer!.includes(',') && !/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/u.test(integer!)) return null;
  const out = hindiCardinal(integer!.replaceAll(',', ''));
  if (fraction !== undefined) out.push('दशमलव', ...Array.from(fraction, Number));
  if (suffix === '%') out.push('प्रतिशत');
  if (suffix === '°') out.push('डिग्री');
  return out;
}

function belowMillion(words: Words, n: number): NumberPart[] {
  if (n < 1000) return [n];
  const count = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = count === 1 ? [words.thousand] : [count, words.thousands];
  if (rest === 0) return head;
  const joiner = words.afterThousand(rest);
  return [...head, ...(joiner ? [joiner] : []), rest];
}

function cardinal(words: Words, digits: string): NumberPart[] {
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  if (trimmed.length > 15) return Array.from(digits, Number);
  const n = Number(trimmed);
  if (n < 1_000_000) return belowMillion(words, n);
  const out: NumberPart[] = [];
  const scales: Array<[number, [string, string]]> = [[1e12, words.billion], [1e6, words.million]];
  let rest = n;
  for (const [size, [one, many]] of scales) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (count === 0) continue;
    out.push(...(count === 1 ? [words.one, one] : [...belowMillion(words, count), many]));
  }
  if (rest > 0) out.push(...belowMillion(words, rest));
  return out;
}

const NUMBER = /^(\d+(?:[.,]\d+)*)([º°ª%]?)$/u;

/**
 * How to read a token that is a number, or `null` when it is not one this
 * reads (dates, times and other mixed tokens are split by the caller first).
 */
export function numberParts(language: LearnedLanguage, token: string): NumberPart[] | null {
  if (language === 'hi') return hindiParts(token);
  const match = NUMBER.exec(token);
  if (!match) return null;
  const words = LANGUAGES[language];
  const [, number, suffix] = match;
  // "1.250,99": dots group thousands, so only the comma is a decimal point.
  const grouped = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(number!);
  const [whole, ...fractions] = grouped
    ? [grouped[1]!.replaceAll('.', ''), ...(grouped[2] === undefined ? [] : [',', grouped[2]])]
    : number!.split(/([.,])/);
  const value = cardinal(words, whole!);
  for (let index = 0; index < fractions.length; index += 2) {
    const fraction = fractions[index + 1]!;
    value.push(fractions[index] === ',' ? words.decimal : words.point);
    // "3,05" keeps its zero: "tres coma cero cinco".
    const leading = /^0+/.exec(fraction)?.[0] ?? '';
    value.push(...Array.from(leading, () => 0));
    if (leading.length < fraction.length) value.push(...cardinal(words, fraction.slice(leading.length)));
  }
  if (suffix === '%') return [...value, ...words.percent];
  if (suffix === '°') return [...value, words.degrees];
  if (suffix === 'º' || suffix === 'ª') {
    const n = Number(number);
    const ordinals = suffix === 'ª' ? words.ordinals.feminine : words.ordinals.masculine;
    if (Number.isInteger(n) && n >= 1 && n <= ordinals.length) return [ordinals[n - 1]!];
  }
  return value;
}
