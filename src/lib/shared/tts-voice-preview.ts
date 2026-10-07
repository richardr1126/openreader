import {
  getKokoroVoiceLanguages,
  toBaseLanguageCode,
} from '@openreader/tts/language';

/** Server-side cap on preview text; mirrors the worker's request schema. */
export const TTS_VOICE_PREVIEW_MAX_TEXT_CHARS = 300;
/** The browser trims the reader's sentence to this before asking for a preview. */
export const TTS_VOICE_PREVIEW_TARGET_CHARS = 200;

const SAMPLE_BY_BASE_LANGUAGE: Record<string, string> = {
  en: 'Every story finds its own voice, and this is how I would read yours.',
  es: 'Cada historia encuentra su propia voz, y así es como leería la tuya.',
  fr: 'Chaque histoire trouve sa propre voix, et voici comment je lirais la vôtre.',
  hi: 'हर कहानी अपनी आवाज़ ढूँढ लेती है, और मैं आपकी कहानी ऐसे पढ़ूँगा।',
  it: 'Ogni storia trova la propria voce, ed ecco come leggerei la tua.',
  ja: 'どの物語にも自分の声があります。あなたの物語はこんなふうに読みます。',
  pt: 'Toda história encontra a sua própria voz, e é assim que eu leria a sua.',
  zh: '每个故事都有自己的声音，这就是我朗读你的故事的方式。',
};

/** A short fixed sample in a language; English when none is known. */
export function voicePreviewSampleText(language: string | null | undefined): string {
  return SAMPLE_BY_BASE_LANGUAGE[toBaseLanguageCode(language)] ?? SAMPLE_BY_BASE_LANGUAGE.en;
}

/** Shortens text to at most `limit` characters, preferring a word boundary. */
export function truncateVoicePreviewText(text: string, limit = TTS_VOICE_PREVIEW_TARGET_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/u, '');
}

/**
 * Picks what a preview says: the reader's current sentence when the draft
 * voice can speak the document's language, otherwise a sample in the voice's
 * own language so a Japanese voice is not judged on English text.
 */
export function buildVoicePreviewText(input: {
  currentSentence: string | null | undefined;
  documentLanguage: string | null | undefined;
  voice: string;
}): string {
  const voiceLanguages = getKokoroVoiceLanguages(input.voice);
  const voiceBase = voiceLanguages.length > 0 ? toBaseLanguageCode(voiceLanguages[0]) : null;
  const documentLanguage = input.documentLanguage?.trim();
  const knownDocumentLanguage = documentLanguage && documentLanguage.toLowerCase() !== 'auto'
    ? documentLanguage
    : null;
  const sentence = input.currentSentence?.trim();
  if (sentence && (!voiceBase || !knownDocumentLanguage || voiceBase === toBaseLanguageCode(knownDocumentLanguage))) {
    return truncateVoicePreviewText(sentence);
  }
  return voicePreviewSampleText(voiceBase ?? knownDocumentLanguage);
}
