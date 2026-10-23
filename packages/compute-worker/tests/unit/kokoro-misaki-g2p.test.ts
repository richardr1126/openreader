/**
 * Golden phonemes for the Misaki port, carried over from the iOS port's
 * MisakiG2PTests and LetterToSoundTests (themselves upstream's expectations).
 *
 * A failure here means the model will say different words. The audio cache is
 * keyed on text and voice, not phonemes, so treat a diff as a regression to
 * explain rather than a baseline to update.
 *
 * The data is a recorded subset of the real dictionaries and rules; regenerate
 * it with scripts/kokoro-g2p-fixture.ts after adding a sentence to
 * tests/fixtures/kokoro-g2p/sentences.json.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { G2P } from '../../src/inference/kokoro/misaki/g2p';
import { LetterToSound } from '../../src/inference/kokoro/misaki/letter-to-sound';
import { Lexicon, US_VOCAB } from '../../src/inference/kokoro/misaki/lexicon';
import { NumberToWords } from '../../src/inference/kokoro/misaki/number-to-words';

const fixtureDir = path.resolve(process.cwd(), 'packages/compute-worker/tests/fixtures/kokoro-g2p');
const fixture = (name: string) => readFileSync(path.join(fixtureDir, name), 'utf8');

const lts = new LetterToSound(fixture('letter_to_sound.tsv'));
const britishLts = new LetterToSound(fixture('letter_to_sound_gb.tsv'));
function createG2P(british = false): G2P {
  const dialect = british ? 'gb' : 'us';
  return new G2P({
    lexicon: new Lexicon({
      british,
      data: {
        gold: JSON.parse(fixture(`${dialect}_gold.json`)),
        silver: JSON.parse(fixture(`${dialect}_silver.json`)),
      },
      letterToSound: british ? britishLts : lts,
    }),
  });
}

const g2p = createG2P();
const say = (text: string) => g2p.phonemize(text).phonemes;

describe('Misaki G2P', () => {
  it('reads the indefinite article as a determiner, not the letter A', () => {
    expect(say('He picked up a book.')).toContain('ɐ bˈʊk');
  });

  it('speaks a possessive as one word, not as the letter S', () => {
    expect(say("Richard's book").startsWith('ɹˈɪʧəɹdz')).toBe(true);
    expect(say("the dog's bowl")).toContain('dˈɔɡz');
    expect(say("James's car")).toContain('ʤˈAmzᵻz');
    expect(say('Richard’s book').startsWith('ɹˈɪʧəɹdz')).toBe(true);
    expect(say("it's fine").startsWith('ɪts')).toBe(true);
    expect(say("don't stop").startsWith('dˈOnt')).toBe(true);
  });

  it('drops the apostrophe of a plural possessive', () => {
    expect(say("the boys' room")).toBe('ðə bˈYz ɹˈum');
    expect(say("Chris' hat")).toBe('kɹˈɪs hˈæt');
  });

  it('keeps a closing single quote', () => {
    expect(say("he said 'stop' loudly")).toContain('“stˈɑp”');
    expect(say('‘stop’ she said').startsWith('“stˈɑp”')).toBe(true);
  });

  it('does not pause at a hyphen inside a compound', () => {
    for (const compound of ['a well-known idea', 'state-of-the-art', 'mother-in-law', 're-enter']) {
      expect(say(compound), compound).not.toContain('—');
    }
    expect(say('a well-known idea')).toBe('ɐ wˈɛlnˈOn Idˈiə');
  });

  it('speaks symbols as the words they stand for', () => {
    expect(say('Ben & Jerry')).toContain('ænd');
    expect(say('5 + 3 apples')).toContain('plˈʌs');
    expect(say('I read 100% of it')).toContain('pəɹsˈɛnt');
    expect(say('mail me @ home')).toContain('æt');
    expect(say('"Quoted," she said.')).toBe('“kwˈOTᵻd,” ʃi sˈɛd.');
  });

  it('still pauses at a standalone dash and a numeric range', () => {
    for (const text of ['he paused - then left', 'he paused -- then left', 'he paused — then left']) {
      expect(say(text), text).toContain('—');
    }
    expect(say('the 1939-1945 war')).toContain('—');
    expect(say('a 3.5-inch disk')).not.toContain('—');
  });

  it('folds diacritics before giving up on a word', () => {
    expect(say('naïve café résumé')).toBe(say('naive cafe resume'));
    expect(say('naïve café résumé')).not.toContain(g2p.unk);
    expect(say('the cafe was open')).toContain('kæfˈA');
  });

  it('guesses a word spelled with letters outside ASCII', () => {
    expect(say('the prison in Béjaïa')).toBe('ðə pɹˈɪzᵊn ɪn bᵻʤˈAIə');
    expect(say('the Großer park')).toBe('ðə ɡɹˈOsəɹ pˈɑɹk');
  });

  it('reads a contracted auxiliary after a known word', () => {
    expect(say("I should've known.")).toBe('ˌI ʃˈʊdəv nˈOn.');
    expect(say("That'll do.")).toBe('ðˈætəl dˈu.');
    expect(say("What're you doing?")).toBe('wˈʌtəɹ ju dˈuɪŋ?');
    expect(createG2P(true).phonemize("That'll do.").phonemes).toBe('ðˈatᵊl dˈuː.');
  });

  it('guesses British vowels for a British voice', () => {
    expect(createG2P(true).phonemize('Tom met Rhodri.').phonemes).toBe('tˈɒm mˈɛt ɹˈQdɹi.');
  });

  it('builds both dialects', () => {
    expect(say('hello')).not.toBe('');
    expect(createG2P(true).phonemize('hello').phonemes).not.toBe('');
  });

  it('phonemizes the upstream example', () => {
    expect(say('[Misaki](/misˈɑki/) is a G2P engine designed for [Kokoro](/kˈOkəɹO/) models.'))
      .toBe('misˈɑki ɪz ɐ ʤˈitəpˈi ˈɛnʤən dəzˈInd fɔɹ kˈOkəɹO mˈɑdᵊlz.');
  });

  it('reads "the" and "to" from what follows', () => {
    expect(say('the apple')).toBe('ði ˈæpᵊl');
    expect(say('the banana')).toBe('ðə bənˈænə');
    expect(say('to apple')).toBe('tʊ ˈæpᵊl');
    expect(say('to banana')).toBe('tə bənˈænə');
  });

  it('spells an acronym with a digit in it', () => {
    expect(say('G2P')).toBe('ʤˈitəpˈi');
  });

  it('speaks currency without the unknown marker', () => {
    const phonemes = say('$12.50');
    expect(phonemes).not.toContain('❓');
    expect(phonemes).toContain('dˈɑləɹ');
    expect(phonemes).toContain('sˈɛnt');
  });

  it('spells numbers, ordinals and years', () => {
    expect(NumberToWords.cardinal(42)).toBe('forty-two');
    expect(NumberToWords.cardinal(1234)).toBe('one thousand two hundred thirty-four');
    expect(NumberToWords.ordinal(42)).toBe('forty-second');
    expect(NumberToWords.ordinal(101)).toBe('one hundred first');
    expect(NumberToWords.year(1984)).toBe('nineteen eighty-four');
    expect(NumberToWords.year(1905)).toBe('nineteen oh-five');
    expect(NumberToWords.year(2001)).toBe('two thousand one');
  });

  it('returns per-word phonemes that rebuild the joined string', () => {
    const { phonemes, tokens } = g2p.phonemize('The quick brown fox.');
    expect(tokens.filter((token) => token.phonemes).length).toBeGreaterThanOrEqual(4);
    const rebuilt = tokens.map((token) => (token.phonemes ?? '') + token.whitespace).join('').trim();
    expect(rebuilt).toBe(phonemes.trim());
  });

  it('reads a unit after a number as a word', () => {
    const measured = say('50% off, 3 lbs, 20 ft, 100 mg.');
    expect(measured).toContain('pˈWndz');
    expect(measured).toContain('fˈit');
    expect(measured).toContain('mˈɪləɡɹˌæmz');
    expect(measured).not.toContain('❓');
    expect(say('I ran 5 mi at 8 mph in 2 hrs.')).toContain('mˈIlz pɜɹ ˈWəɹ');
    expect(say('It weighs 1.2kg and is 5km away.')).toContain('kˈɪləɡɹˌæmz');
  });

  it('does not expand a unit standing alone', () => {
    expect(say('Wait a min.')).not.toContain('mˈɪnəts');
    expect(say('Ft. Worth')).not.toContain('fˈit');
  });

  it('keeps a dotted title and its full stop together', () => {
    expect(say('Mr. Baggins paid £3 on Jan. 5, 1984.').startsWith('mˈɪstəɹ ')).toBe(true);
  });
});

describe('Misaki letter-to-sound', () => {
  it('gives invented names stressed phonemes in the Kokoro vocabulary', () => {
    for (const name of ['frodo', 'gandalf', 'hermione', 'katniss', 'shallan', 'dalinar']) {
      const guessed = lts.guess(name);
      expect(guessed, name).toBeTruthy();
      expect(Array.from(guessed!).every((c) => US_VOCAB.has(c)), `${name}: ${guessed}`).toBe(true);
      expect(guessed).toContain('ˈ');
    }
  });

  it('leaves dictionary words untouched', () => {
    expect(say('the cafe was open')).toContain('kæfˈA');
    expect(say('He walked to the store.')).toBe('hˌi wˈɔkt tə ðə stˈɔɹ.');
  });

  it('gives a word whose only vowel is reduced the full vowel', () => {
    expect(lts.guess('chan')).toBe('ʧˈʌn');
    expect(lts.guess('va')).toBe('vˈʌ');
  });

  it('refuses the unpronounceable and invents nothing', () => {
    for (const cluster of ['bkzt', 'zzz', 'brrr', 'hmm', 'pbk', 'xkcd']) expect(lts.guess(cluster), cluster).toBeNull();
    for (const word of ['bj', 'frodo', 'zelenskyy', 'mxyzptlk']) {
      const guessed = lts.guess(word);
      if (guessed !== null) expect(/[AIOWYiuæɑɔɛɜɪʊʌ]/u.test(guessed), `${word}: ${guessed}`).toBe(true);
    }
    expect(lts.guess('3rd')).toBeNull();
    expect(lts.guess('')).toBeNull();
    expect(lts.guess('Frodo')).toBe(lts.guess('frodo'));
  });

  it('inflects a possessive on an unknown name', () => {
    const phonemes = say("Frodo's ring and Bilbo's book.");
    expect(phonemes).not.toContain(g2p.unk);
    expect(phonemes).toContain('z ɹˈɪŋ');
  });

  it('loses no word from a sentence of unknown names', () => {
    for (const sentence of ['I saw Frodo today.', 'Gandalf met Hermione and Katniss.', 'Shallan, Dalinar and Kaladin arrived.']) {
      const phonemes = say(sentence);
      expect(phonemes, sentence).not.toContain(g2p.unk);
      const words = sentence.split(/[ ,.]+/).filter(Boolean).length;
      expect(phonemes.split(' ').filter(Boolean).length, `${sentence} -> ${phonemes}`).toBe(words);
    }
  });
});
