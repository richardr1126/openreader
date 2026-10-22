import { describe, expect, test } from 'vitest';

import { LearnedG2P } from '../../src/inference/kokoro/misaki/learned-g2p';
import { LetterToSound } from '../../src/inference/kokoro/misaki/letter-to-sound';
import { numberParts } from '../../src/inference/kokoro/misaki/romance-numbers';

/** A small Spanish-like table in the `tools/learned-g2p` format. */
const TABLE = [
  'maxw\t1',
  'vowels\ta e o',
  'final\t1',
  // Bare letters, and stress on the second-to-last syllable.
  ...['a', 'e', 'm', 'o', 's', 't'].map((letter) => `s1\t|${letter}|\t${letter}`),
  's1\t|r|\tɾ',
  't0\t|1\t1',
  't0\t|2\t10',
  // "de" is `ðe` after a vowel; a final "s" is `z` before "m".
  'e\to|d|a\tð',
  'e\tc|s|m\tz',
  'l\tO\tˈo',
  'l\tN\tˈene',
  'l\tU\tˈu',
  'n\t1\tˈuno',
  'n\t50\tθinkwˈenta',
  'n\t776\tsˌeteθjˈɛntos sɛtˌɛntaisˈAs',
  'w\tde\tde',
  'w\tla\tla',
  'w\tmil\tmˈil',
  'w\tcoma\tkˈoma',
].join('\n');

const phonemes = (text: string) =>
  new LearnedG2P('es', TABLE).phonemize(text).tokens.map((token) => token.phonemes).join(' ');

describe('learned G2P', () => {
  test('changes a word edge only where its neighbour calls for it', () => {
    // After "la" (ends in a), "de" lenites; at the start of a clause it does not.
    expect(phonemes('la de')).toBe('la ðˈe');
    expect(phonemes('de la')).toBe('de lˈa');
  });

  test('stresses a clause-final word that has no stress of its own', () => {
    expect(phonemes('de.')).toBe('dˈe .');
    expect(phonemes('de, la')).toBe('dˈe , lˈa');
  });

  test('guesses unknown words from the rules and changes their last sound', () => {
    expect(phonemes('mesas mesa')).toBe('mˈesaz mˈesa');
  });

  test('keeps punctuation as its own tokens with the original spacing', () => {
    const tokens = new LearnedG2P('es', TABLE).phonemize('¡La mesa!').tokens;
    expect(tokens.map((token) => [token.text, token.whitespace])).toEqual([
      ['¡', ''], ['La', ' '], ['mesa', ''], ['!', ''],
    ]);
  });

  test('spells a short acronym, its earlier letters unstressed', () => {
    expect(phonemes('ONU')).toBe('ˌoˌeneˈu');
  });

  test('reads numbers group by group from the table', () => {
    expect(phonemes('1776')).toBe('mˈil sˌeteθjˈɛntos sɛtˌɛntaisˈAs');
  });

  test('a table with its own vowels never guesses a word without one', () => {
    expect(new LetterToSound(TABLE).guess('st')).toBeNull();
    expect(new LetterToSound(TABLE).guess('mesa')).toBe('mˈesa');
  });
});

describe('romance numbers', () => {
  test('Hindi uses lakh and crore, Indian grouping and Devanagari digits', () => {
    expect(numberParts('hi', '१,२३,४५६')).toEqual([1, 'लाख', 23, 'हज़ार', 456]);
    expect(numberParts('hi', '123,456')).toEqual([1, 'लाख', 23, 'हज़ार', 456]);
    expect(numberParts('hi', '10000000')).toEqual([1, 'करोड़']);
    expect(numberParts('hi', '३.०५%')).toEqual([3, 'दशमलव', 0, 5, 'प्रतिशत']);
    expect(numberParts('hi', '३०°')).toEqual([30, 'डिग्री']);
    expect(numberParts('hi', '०१२३')).toEqual([0, 1, 2, 3]);
    expect(numberParts('hi', '1,23')).toBeNull();
  });
  test('a dot between groups of three is a thousands separator, a comma the decimal point', () => {
    expect(numberParts('es', '3.628.800')).toEqual([3, 'millones', 628, 'mil', 800]);
    expect(numberParts('es', '3,05')).toEqual([3, 'coma', 0, 5]);
    expect(numberParts('es', '1.000,50')).toEqual(['mil', 'coma', 50]);
    expect(phonemes('1.000,50')).toBe('mˈil kˈoma θinkwˈenta');
    expect(numberParts('pt-br', '2.500,05')).toEqual([2, 'mil', 'e', 500, 'vírgula', 0, 5]);
    expect(numberParts('it', '2.5')).toEqual([2, 'punto', 5]);
  });

  test('scales take the shorter "one" and their plural', () => {
    expect(numberParts('es', '1000000')).toEqual(['un', 'millón']);
    expect(numberParts('it', '2000')).toEqual([2, 'mila']);
    expect(numberParts('it', '1000')).toEqual(['mille']);
  });

  test('Portuguese joins thousands to a small or round remainder with "e"', () => {
    expect(numberParts('pt-br', '1001')).toEqual(['mil', 'e', 1]);
    expect(numberParts('pt-br', '1200')).toEqual(['mil', 'e', 200]);
    expect(numberParts('pt-br', '1234')).toEqual(['mil', 234]);
  });

  test('reads percentages, degrees and ordinals', () => {
    expect(numberParts('es', '45%')).toEqual([45, 'por', 'ciento']);
    expect(numberParts('pt-br', '30°')).toEqual([30, 'graus']);
    expect(numberParts('es', '5ª')).toEqual(['quinta']);
    expect(numberParts('it', '2º')).toEqual(['secondo']);
  });

  test('leaves mixed tokens to the caller', () => {
    expect(numberParts('es', '10:30')).toBeNull();
    expect(numberParts('es', 'abc')).toBeNull();
  });
});

describe('Hindi learned G2P', () => {
  const hindi = [
    'maxw\t1', 'scalars\t1', 'vowels\ta i',
    's1\t|क|\tk', 's1\t|ि|\ti', 's1\t|त|\tt', 's1\t|ा|\ta', 's1\t|ब|\tb',
    't0\t|2\t10', 'n\t123\tˈeːksˈɔː tˈeːis', 'n\t1\tˈeːk', 'n\t2\tdˈoː', 'n\t3\ttˈiːn',
  ].join('\n');

  test('applies spelling rules to code points including vowel signs', () => {
    expect(new LetterToSound(hindi).guess('किताब')).toBe('kˈitab');
  });

  test('restores a table-declared vowel after an aspirated consonant instead of dropping a word', () => {
    const rules = ['maxw\t1', 'vowels\tʌ', 'fallback_vowel\tʌ', 's1\t|स|\tsʰ', 's1\t|ख|\tkʰ', 's1\t|त|\tt'].join('\n');
    expect(new LetterToSound(rules).guess('सखत')).toBe('sʰˈʌkʰt');
  });

  test('reads quoted Hindi words without losing their surface text', () => {
    const tokens = new LearnedG2P('hi', hindi).phonemize("'किताब'").tokens;
    expect(tokens.map((token) => token.text).join('')).toBe("'किताब'");
    expect(tokens.find((token) => token.text === 'किताब')?.phonemes).toBe('kˈitab');
  });

  test('does not drop punctuation-separated words beside a number', () => {
    const tokens = new LearnedG2P('hi', hindi).phonemize('किताब/किताब१२३').tokens;
    expect(tokens[0]?.text).toBe('किताब/किताब१२३');
    expect(tokens[0]?.phonemes).toBe('kˈitab kˈitab ˈeːksˈɔː tˈeːis');
    expect(new LearnedG2P('hi', hindi).phonemize('१,२३').tokens[0]?.phonemes).toBe('ˈeːk dˈoː tˈiːn');
  });

  test('preserves native digits and danda for word offsets', () => {
    const tokens = new LearnedG2P('hi', hindi).phonemize('किताब १२३।').tokens;
    expect(tokens.map(({ text, phonemes, whitespace }) => [text, phonemes, whitespace])).toEqual([
      ['किताब', 'kˈitab', ' '], ['१२३', 'ˈeːksˈɔː tˈeːis', ''], ['।', '', ''],
    ]);
  });
});
