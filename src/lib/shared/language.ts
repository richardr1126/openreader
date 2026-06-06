export const DEFAULT_TTS_LANGUAGE = 'en';

export interface TextToken {
  text: string;
  start: number;
  end: number;
}

const KOKORO_LANGUAGE_BY_PREFIX: Readonly<Record<string, string>> = {
  af: 'en-US',
  am: 'en-US',
  bf: 'en-GB',
  bm: 'en-GB',
  ef: 'es',
  em: 'es',
  ff: 'fr',
  hf: 'hi',
  hm: 'hi',
  if: 'it',
  im: 'it',
  jf: 'ja',
  jm: 'ja',
  pf: 'pt-BR',
  pm: 'pt-BR',
  zf: 'zh-CN',
  zm: 'zh-CN',
};

export function normalizeLanguageTag(
  language: string | null | undefined,
  fallback = DEFAULT_TTS_LANGUAGE,
): string {
  const candidate = language?.trim();
  if (!candidate || candidate.toLowerCase() === 'auto') return fallback;

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

export function toBaseLanguageCode(language: string | null | undefined): string {
  const normalized = normalizeLanguageTag(language);
  try {
    return new Intl.Locale(normalized).language;
  } catch {
    return normalized.split('-')[0]?.toLowerCase() || DEFAULT_TTS_LANGUAGE;
  }
}

export function inferKokoroLanguageFromVoice(voice: string | null | undefined): string | null {
  if (!voice?.trim()) return null;

  const languages = new Set(
    voice
      .split('+')
      .map((part) => part.trim().replace(/\([^)]*\)/g, ''))
      .map((name) => KOKORO_LANGUAGE_BY_PREFIX[name.slice(0, 2).toLowerCase()])
      .filter((language): language is string => Boolean(language)),
  );

  return languages.size === 1 ? [...languages][0] : null;
}

export function resolveTtsLanguage(input: {
  configuredLanguage?: string | null;
  voice?: string | null;
}): string {
  const configured = input.configuredLanguage?.trim();
  if (configured && configured.toLowerCase() !== 'auto') {
    return normalizeLanguageTag(configured);
  }

  return inferKokoroLanguageFromVoice(input.voice) ?? DEFAULT_TTS_LANGUAGE;
}

export function normalizeUnicodeToken(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

export function segmentSentences(text: string, language?: string | null): string[] {
  const normalizedLanguage = normalizeLanguageTag(language);
  try {
    return [...new Intl.Segmenter(normalizedLanguage, { granularity: 'sentence' }).segment(text)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
  } catch {
    return text.split(/(?<=[.!?。！？؟।])\s*/u).map((segment) => segment.trim()).filter(Boolean);
  }
}

export function segmentWords(text: string, language?: string | null): TextToken[] {
  const normalizedLanguage = normalizeLanguageTag(language);
  try {
    return [...new Intl.Segmenter(normalizedLanguage, { granularity: 'word' }).segment(text)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => ({
        text: segment.segment,
        start: segment.index,
        end: segment.index + segment.segment.length,
      }));
  } catch {
    const tokens: TextToken[] = [];
    const wordRegex = /\S+/gu;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(text)) !== null) {
      tokens.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return tokens;
  }
}
