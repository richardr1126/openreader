import { isKokoroModel } from './kokoro';

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

const REPLICATE_KOKORO_LANGUAGE_CODE_BY_TAG: Readonly<Record<string, string>> = {
  'en-US': 'a',
  'en-GB': 'b',
  es: 'e',
  fr: 'f',
  hi: 'h',
  it: 'i',
  ja: 'j',
  'pt-BR': 'p',
  'zh-CN': 'z',
};

const REPLICATE_KOKORO_LANGUAGE_CODE_BY_BASE_TAG: Readonly<Record<string, string>> = {
  es: 'e',
  fr: 'f',
  hi: 'h',
  it: 'i',
  ja: 'j',
  pt: 'p',
  zh: 'z',
};

export const KOKORO_SUPPORTED_LANGUAGES = [
  'en',
  'es',
  'fr',
  'hi',
  'it',
  'ja',
  'pt-BR',
  'zh-CN',
] as const;

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

export function normalizeOptionalLanguageTag(language: unknown): string | null {
  if (typeof language !== 'string') return null;
  const candidate = language.trim().split(/[,\s]+/u)[0];
  if (!candidate) return null;
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? null;
  } catch {
    return null;
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
  const languages = new Set(getKokoroVoiceLanguages(voice));

  return languages.size === 1 ? [...languages][0] : null;
}

export function resolveReplicateKokoroLanguageCode(input: {
  language?: string | null;
  voice?: string | null;
}): string | null {
  const normalizedLanguage = input.language ? normalizeLanguageTag(input.language) : null;
  const voiceLanguage = inferKokoroLanguageFromVoice(input.voice);

  for (const candidate of [normalizedLanguage, voiceLanguage]) {
    if (!candidate) continue;

    const exactCode = REPLICATE_KOKORO_LANGUAGE_CODE_BY_TAG[candidate];
    if (exactCode) return exactCode;

    const baseCode = REPLICATE_KOKORO_LANGUAGE_CODE_BY_BASE_TAG[toBaseLanguageCode(candidate)];
    if (baseCode) return baseCode;
  }

  return null;
}

export function getKokoroVoiceLanguages(voice: string | null | undefined): string[] {
  if (!voice?.trim()) return [];
  return Array.from(new Set(
    voice
      .split('+')
      .map((part) => part.trim().replace(/\([^)]*\)/g, ''))
      .map((name) => KOKORO_LANGUAGE_BY_PREFIX[name.slice(0, 2).toLowerCase()])
      .filter((language): language is string => Boolean(language)),
  ));
}

export function keepKokoroVoicesInOneLanguage(
  voices: string[],
  preferredVoice?: string | null,
): string[] {
  const preferredLanguage = getKokoroVoiceLanguages(preferredVoice)[0]
    ?? voices.flatMap((voice) => getKokoroVoiceLanguages(voice))[0];
  if (!preferredLanguage) return voices;

  const preferredBaseLanguage = toBaseLanguageCode(preferredLanguage);
  return voices.filter((voice) => {
    const voiceLanguage = getKokoroVoiceLanguages(voice)[0];
    return !voiceLanguage || toBaseLanguageCode(voiceLanguage) === preferredBaseLanguage;
  });
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

export function getLanguageDisplayName(language: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
}

export function getTtsLanguageCompatibilityWarnings(input: {
  model?: string | null;
  voice?: string | null;
  documentLanguage?: string | null;
}): string[] {
  if (!isKokoroModel(input.model || '')) return [];

  const documentLanguage = normalizeLanguageTag(input.documentLanguage);
  const documentBaseLanguage = toBaseLanguageCode(documentLanguage);
  const supportedBaseLanguages = new Set(KOKORO_SUPPORTED_LANGUAGES.map((language) => toBaseLanguageCode(language)));
  const voiceLanguages = getKokoroVoiceLanguages(input.voice);
  const voiceBaseLanguages = new Set(voiceLanguages.map((language) => toBaseLanguageCode(language)));
  const warnings: string[] = [];

  if (!supportedBaseLanguages.has(documentBaseLanguage)) {
    warnings.push(
      `Kokoro's built-in voice catalog does not include ${getLanguageDisplayName(documentLanguage)}.`,
    );
  }

  const voiceLanguage = voiceBaseLanguages.size === 1 ? voiceLanguages[0] : undefined;
  if (voiceLanguage && toBaseLanguageCode(voiceLanguage) !== documentBaseLanguage) {
    warnings.push(
      `Selected Kokoro voice is ${getLanguageDisplayName(voiceLanguage)}, but the document is ${getLanguageDisplayName(documentLanguage)}.`,
    );
  }

  return warnings;
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
