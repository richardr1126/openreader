/**
 * TypeScript port of the OpenReader iOS `LetterToSound`: spelling-to-phoneme
 * rules induced offline by the iOS repository's tooling. English tables come
 * from the Apache-2.0 Misaki dictionaries (`tools/letter-to-sound`), used in
 * place of upstream Misaki's espeak fallback; the other languages' tables are
 * part of their `LearnedG2P` data (`tools/learned-g2p`). Apache-2.0; see
 * ../assets/LICENSE.txt.
 *
 * It is the last step before an unknown word would otherwise reach Kokoro as
 * the unknown marker, which the model's vocabulary drops — a deleted word. A
 * plausible reading is the smaller failure.
 */

/** English vowels that can carry stress; `ᵻ` and `ᵊ` are reduced and never marked. */
const ENGLISH_STRESSABLE = new Set(Array.from('AIOQWYaiuæɑɒɔɛɜɪʊʌ'));
/** The full vowel a reduced one stands for when it has to carry the stress. */
const UNREDUCED: Record<string, string> = { 'ə': 'ʌ', 'ᵻ': 'ɪ', 'ᵊ': 'ʌ' };
const ASCII_LETTER = /^[a-z]$/;

/** Code points, each combining mark kept with the one before it (`ɐ̃` is one). */
export function phonemeSymbols(phonemes: string): string[] {
  return phonemes.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
}

export class LetterToSound {
  /** Rules keyed by context, widest first; the last level is the bare letter. */
  private readonly skeleton: Map<string, string>[];
  /** Stress patterns keyed by `suffix|syllableCount`, indexed by suffix length. */
  private readonly stressPatterns: Map<string, string>[];
  private readonly maxWidth: number;
  /**
   * The symbols that carry stress. A table may list its own (`vowels`); an
   * English table does not, and also lets a reduced vowel take the stress.
   */
  private readonly stressable: Set<string>;
  private readonly english: boolean;
  /** A table may restore a vowel when learned deletion leaves only consonants. */
  private readonly fallbackVowel: string | null;

  constructor(tsv: string) {
    let vowels: string[] | null = null;
    let width = 5;
    let fallbackVowel: string | null = null;
    const skeleton = Array.from({ length: 8 }, () => new Map<string, string>());
    const stress = Array.from({ length: 8 }, () => new Map<string, string>());
    for (const line of tsv.split('\n')) {
      if (!line) continue;
      const first = line.indexOf('\t');
      if (first < 0) continue;
      const kind = line.slice(0, first);
      if (kind === 'fallback_vowel') {
        fallbackVowel = line.slice(first + 1) || null;
        continue;
      }
      if (kind === 'maxw') {
        width = Number.parseInt(line.slice(first + 1), 10) || 5;
        continue;
      }
      if (kind === 'vowels') {
        vowels = line.slice(first + 1).split(' ').filter(Boolean);
        continue;
      }
      const second = line.indexOf('\t', first + 1);
      if (second < 0) continue;
      const level = Number.parseInt(kind.slice(1), 10);
      if (!Number.isInteger(level) || level < 0 || level >= 8) continue;
      const key = line.slice(first + 1, second);
      const value = line.slice(second + 1);
      if (kind.startsWith('s')) skeleton[level]!.set(key, value);
      else if (kind.startsWith('t')) stress[level]!.set(key, value);
    }
    this.maxWidth = width;
    this.skeleton = skeleton;
    this.stressPatterns = stress;
    this.stressable = vowels ? new Set(vowels) : ENGLISH_STRESSABLE;
    this.english = vowels === null;
    this.fallbackVowel = fallbackVowel;
  }

  /**
   * `null` for a word with a letter the rules do not cover, or with no vowel.
   * English rules cover a–z, though not every letter keeps a bare rule; a
   * learned table covers exactly the letters that have one.
   */
  guess(word: string): string | null {
    const letters = Array.from(word.toLowerCase());
    const bareLetters = this.skeleton[this.maxWidth];
    const covered = (letter: string) => (this.english ? ASCII_LETTER.test(letter) : bareLetters?.has(`|${letter}|`));
    if (letters.length === 0 || !letters.every(covered)) return null;

    // "^" and "$" are real context: rules can match only at a word edge.
    const padded = ['^', ...letters, '$'];
    let bare = '';
    for (let index = 0; index < letters.length; index += 1) {
      const centre = index + 1;
      let emitted: string | undefined;
      for (let width = this.maxWidth; width >= 1; width -= 1) {
        const left = padded.slice(Math.max(0, centre - width), centre).join('');
        const right = padded.slice(centre + 1, Math.min(padded.length, centre + 1 + width)).join('');
        emitted = this.skeleton[this.maxWidth - width]?.get(`${left}|${padded[centre]}|${right}`);
        if (emitted !== undefined) break;
      }
      bare += emitted ?? this.skeleton[this.maxWidth]?.get(`|${padded[centre]}|`) ?? '';
    }

    const phonemes = phonemeSymbols(bare);
    let syllables = phonemes.filter((phoneme) => this.stressable.has(phoneme)).length;
    if (syllables === 0) {
      if (!this.english) {
        if (!this.fallbackVowel || phonemes.length === 0) return null;
        let index = 1;
        while (index < phonemes.length && ['ʰ', 'ʲ', 'ː'].includes(phonemes[index]!)) index += 1;
        phonemes.splice(index, 0, this.fallbackVowel);
        syllables = 1;
      } else {
        // A short word can come out with only a reduced vowel ("va" is `və`,
        // "chan" `ʧən`); it still has a syllable, so give it the full vowel. No
        // vowel at all means no pronounceable word; initialisms have their own
        // path.
        const reduced = phonemes.findIndex((phoneme) => Object.hasOwn(UNREDUCED, phoneme));
        if (reduced < 0) return null;
        phonemes[reduced] = UNREDUCED[phonemes[reduced]!]!;
        syllables = 1;
      }
    }

    let pattern: string | undefined;
    for (let length = 6; length >= 0; length -= 1) {
      const suffix = length === 0 ? '' : letters.slice(-length).join('');
      pattern = this.stressPatterns[length]?.get(`${suffix}|${syllables}`);
      if (pattern !== undefined) break;
    }
    // English defaults to the first syllable, as does an ending never seen.
    const marks = Array.from(pattern?.length === syllables ? pattern : `1${'0'.repeat(syllables - 1)}`);

    let result = '';
    let syllable = 0;
    for (const phoneme of phonemes) {
      if (this.stressable.has(phoneme)) {
        const mark = marks[syllable];
        result += mark === '1' ? 'ˈ' : mark === '2' ? 'ˌ' : '';
        syllable += 1;
      }
      result += phoneme;
    }
    return result;
  }
}
