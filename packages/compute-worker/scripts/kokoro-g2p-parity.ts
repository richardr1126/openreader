/**
 * Phonemizes a G2P parity corpus with the worker's Misaki port, for scoring
 * against Kokoro's own pipeline by the parity harness in the OpenReader iOS
 * repository (`tools/g2p-parity`), which owns the corpus and the reference.
 *
 *   pnpm exec tsx packages/compute-worker/scripts/kokoro-g2p-parity.ts \
 *     <data-dir> <corpus.tsv> <us|gb|es|hi|it|pt-br> <out.jsonl>
 *
 * `<data-dir>` is laid out as the worker downloads Kokoro: the Misaki
 * dictionaries under `misaki/` and the letter-to-sound and `LearnedG2P` tables
 * under `g2p/`. The worker's Kokoro model directory is one; the iOS
 * `Tests/PronunciationData/Pronunciation` holds the English files. Each line of
 * the output is `{"id", "phonemes"}`, the phonemes joined exactly as the
 * engine joins a chunk's tokens.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { G2P } from '../src/inference/kokoro/misaki/g2p';
import { LearnedG2P } from '../src/inference/kokoro/misaki/learned-g2p';
import { LetterToSound } from '../src/inference/kokoro/misaki/letter-to-sound';
import { Lexicon } from '../src/inference/kokoro/misaki/lexicon';
import type { LearnedLanguage } from '../src/inference/kokoro/misaki/romance-numbers';
import { kokoroG2PTableFile, type KokoroLanguage } from '../src/inference/kokoro/model-files';

const [dataDir, corpusPath, language, outPath] = process.argv.slice(2);
const LEARNED = ['es', 'it', 'pt-br', 'hi'];
if (!dataDir || !corpusPath || !language || !['us', 'gb', ...LEARNED].includes(language) || !outPath) {
  console.error('usage: kokoro-g2p-parity.ts <data-dir> <corpus.tsv> <us|gb|es|hi|it|pt-br> <out.jsonl>');
  process.exit(1);
}

const read = (name: string) => readFileSync(path.join(dataDir, name), 'utf8');
const table = read(kokoroG2PTableFile(language as KokoroLanguage));
const g2p = LEARNED.includes(language)
  ? new LearnedG2P(language as LearnedLanguage, table)
  : new G2P({
    lexicon: new Lexicon({
      british: language === 'gb',
      data: { gold: JSON.parse(read(`misaki/${language}_gold.json`)), silver: JSON.parse(read(`misaki/${language}_silver.json`)) },
      letterToSound: new LetterToSound(table),
    }),
    unk: '',
  });

const lines: string[] = [];
for (const row of readFileSync(corpusPath, 'utf8').split('\n')) {
  const tab = row.indexOf('\t');
  if (tab < 0) continue;
  const { tokens } = g2p.phonemize(row.slice(tab + 1));
  const phonemes = tokens.map((token) => (token.phonemes ?? '') + (token.whitespace ? ' ' : '')).join('').trim();
  lines.push(JSON.stringify({ id: row.slice(0, tab), phonemes }));
}
writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(`${lines.length} sentences -> ${outPath}`);
