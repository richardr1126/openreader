/**
 * TypeScript port of the OpenReader iOS `LetterToSound`: rules induced from
 * the Apache-2.0 Misaki dictionaries (`tools/letter-to-sound` in the iOS
 * repository), used in place of upstream Misaki's espeak fallback. Nothing in
 * the rules or this code derives from espeak. Apache-2.0; see
 * ../assets/LICENSE.txt.
 *
 * It is the last step before an unknown word would otherwise reach Kokoro as
 * the unknown marker, which the model's vocabulary drops — a deleted word. A
 * plausible English reading is the smaller failure.
 */

/** Vowels that can carry stress; `ᵻ` and `ᵊ` are reduced and never marked. */
const STRESSABLE = new Set(Array.from('AIOWYiuæɑɔɛɜɪʊʌ'));
const ASCII_LETTER = /^[a-z]$/;

export class LetterToSound {
  /** Rules keyed by context, widest first; the last level is the bare letter. */
  private readonly skeleton: Map<string, string>[];
  /** Stress patterns keyed by `suffix|syllableCount`, indexed by suffix length. */
  private readonly stressPatterns: Map<string, string>[];
  private readonly maxWidth: number;

  constructor(tsv: string) {
    let width = 5;
    const skeleton = Array.from({ length: 8 }, () => new Map<string, string>());
    const stress = Array.from({ length: 8 }, () => new Map<string, string>());
    for (const line of tsv.split('\n')) {
      if (!line) continue;
      const first = line.indexOf('\t');
      if (first < 0) continue;
      const kind = line.slice(0, first);
      if (kind === 'maxw') {
        width = Number.parseInt(line.slice(first + 1), 10) || 5;
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
  }

  /** `null` for anything that is not a plain ASCII word, or has no vowel. */
  guess(word: string): string | null {
    const letters = Array.from(word.toLowerCase());
    if (letters.length === 0 || !letters.every((letter) => ASCII_LETTER.test(letter))) return null;

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

    const phonemes = Array.from(bare);
    const syllables = phonemes.filter((phoneme) => STRESSABLE.has(phoneme)).length;
    // No vowel means no pronounceable word; initialisms have their own path.
    if (syllables === 0) return null;

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
      if (STRESSABLE.has(phoneme)) {
        const mark = marks[syllable];
        result += mark === '1' ? 'ˈ' : mark === '2' ? 'ˌ' : '';
        syllable += 1;
      }
      result += phoneme;
    }
    return result;
  }
}
