/**
 * Dependency-free language guess for imported plain text, used only when a
 * document carries no language metadata. It recognises a language by its
 * writing system, or for Latin-script text by its most frequent function
 * words. Like the iOS BookLanguageDetector it samples three spaced body
 * excerpts and needs two of them to agree, so a preface, contents page, or
 * quotation cannot decide the result. Unknown is preferred to a wrong guess.
 */

const SAMPLE_CHARS = 4_000;
const MIN_LETTERS = 60;

const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'it', 'was', 'he', 'for', 'with', 'as', 'his', 'on', 'be', 'at', 'by', 'had', 'not', 'are', 'but', 'from', 'they', 'you', 'this', 'which', 'she', 'her', 'have'],
  es: ['de', 'la', 'que', 'el', 'en', 'y', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'sí', 'porque', 'esta'],
  fr: ['de', 'la', 'le', 'et', 'les', 'des', 'en', 'un', 'du', 'une', 'que', 'est', 'pour', 'qui', 'dans', 'il', 'pas', 'au', 'sur', 'se', 'ne', 'plus', 'par', 'je', 'avec', 'elle', 'son', 'mais', 'nous', 'vous'],
  de: ['der', 'die', 'und', 'in', 'den', 'von', 'zu', 'das', 'mit', 'sich', 'des', 'auf', 'für', 'ist', 'im', 'dem', 'nicht', 'ein', 'eine', 'als', 'auch', 'es', 'an', 'er', 'hat', 'aus', 'bei', 'sie', 'nach', 'wie'],
  it: ['di', 'e', 'il', 'la', 'che', 'in', 'a', 'per', 'un', 'del', 'non', 'è', 'una', 'le', 'si', 'con', 'i', 'della', 'da', 'al', 'lo', 'gli', 'ma', 'come', 'più', 'nel', 'anche', 'sono', 'ha', 'questo'],
  pt: ['de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'é', 'com', 'não', 'uma', 'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'ao', 'ele', 'das', 'à', 'seu', 'sua'],
  nl: ['de', 'en', 'van', 'het', 'een', 'in', 'is', 'dat', 'op', 'te', 'zijn', 'met', 'voor', 'niet', 'aan', 'er', 'die', 'maar', 'ook', 'als', 'bij', 'om', 'dan', 'hij', 'nog', 'wel', 'naar', 'ze', 'wat', 'zij'],
};

const STOPWORD_SETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([language, words]) => [language, new Set(words)]),
) as Record<string, Set<string>>;

type Script =
  | 'latin' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic'
  | 'devanagari' | 'greek' | 'hebrew' | 'thai';

const SCRIPT_PATTERNS: ReadonlyArray<[Script, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
];

function countScripts(sample: string): { counts: Map<Script, number>; letters: number } {
  const counts = new Map<Script, number>();
  let letters = 0;
  for (const char of sample) {
    if (!/\p{L}/u.test(char)) continue;
    letters += 1;
    for (const [script, pattern] of SCRIPT_PATTERNS) {
      if (pattern.test(char)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }
  return { counts, letters };
}

function guessLatin(sample: string): string | null {
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 20) return null;
  const scores = Object.keys(STOPWORD_SETS).map((language) => {
    const set = STOPWORD_SETS[language];
    let hits = 0;
    for (const word of words) if (set.has(word)) hits += 1;
    return { language, hits };
  }).sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scores;
  if (!best || best.hits / words.length < 0.12) return null;
  if (runnerUp && best.hits < runnerUp.hits * 1.3) return null;
  return best.language;
}

/** One sample's guess, or null when it is too short or ambiguous. */
export function guessSampleLanguage(sample: string): string | null {
  const { counts, letters } = countScripts(sample);
  if (letters < MIN_LETTERS) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [dominant, dominantCount] = ranked[0] ?? [];
  if (!dominant || !dominantCount || dominantCount / letters < 0.5) {
    // Japanese mixes kanji and kana; neither alone may be a majority.
    const cjk = (counts.get('han') ?? 0) + (counts.get('kana') ?? 0);
    return cjk / letters >= 0.5 && (counts.get('kana') ?? 0) > 0 ? 'ja' : null;
  }
  switch (dominant) {
    case 'latin': return guessLatin(sample);
    case 'kana': return 'ja';
    case 'han': return (counts.get('kana') ?? 0) / dominantCount > 0.05 ? 'ja' : 'zh';
    case 'hangul': return 'ko';
    case 'cyrillic': return /[іїєґ]/iu.test(sample) ? 'uk' : 'ru';
    case 'arabic': return /[پچژگ]/u.test(sample) ? 'fa' : 'ar';
    case 'devanagari': return 'hi';
    case 'greek': return 'el';
    case 'hebrew': return 'he';
    case 'thai': return 'th';
    default: return null;
  }
}

function sampleAt(text: string, start: number): string {
  // Begin at a word boundary so the first token is whole.
  const boundary = text.indexOf(' ', start);
  const from = boundary >= 0 && boundary - start < 200 ? boundary + 1 : start;
  return text.slice(from, from + SAMPLE_CHARS);
}

export function detectTextLanguage(rawText: string): string | null {
  const text = rawText.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  if (text.length < SAMPLE_CHARS * 2) return guessSampleLanguage(text);

  const votes = new Map<string, number>();
  for (const quarter of [1, 2, 3]) {
    const start = Math.floor((text.length * quarter) / 4) - SAMPLE_CHARS / 2;
    const guess = guessSampleLanguage(sampleAt(text, Math.max(0, start)));
    if (guess) votes.set(guess, (votes.get(guess) ?? 0) + 1);
  }
  const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  return winner && winner[1] >= 2 ? winner[0] : null;
}
