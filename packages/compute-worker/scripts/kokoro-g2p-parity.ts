/**
 * Phonemizes a G2P parity corpus with the worker's Misaki port, for scoring
 * against Kokoro's own pipeline by the parity harness in the OpenReader iOS
 * repository (`tools/g2p-parity`), which owns the corpus and the reference.
 *
 *   pnpm exec tsx packages/compute-worker/scripts/kokoro-g2p-parity.ts \
 *     <data-dir> <corpus.tsv> <us|gb> <out.jsonl>
 *
 * `<data-dir>` holds the full Misaki dictionaries (`DOCSTORE_DIR/model/kokoro-82m/misaki`
 * after a first download, or the iOS `Resources`, which are byte-identical).
 * The letter-to-sound rules are the worker's own bundled copies. Each line of
 * the output is `{"id", "phonemes"}`, the phonemes joined exactly as the
 * engine joins a chunk's tokens.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { G2P } from '../src/inference/kokoro/misaki/g2p';
import { LetterToSound } from '../src/inference/kokoro/misaki/letter-to-sound';
import { Lexicon } from '../src/inference/kokoro/misaki/lexicon';
import { kokoroLetterToSoundPath } from '../src/inference/kokoro/model-files';

const [dataDir, corpusPath, dialect, outPath] = process.argv.slice(2);
if (!dataDir || !corpusPath || (dialect !== 'us' && dialect !== 'gb') || !outPath) {
  console.error('usage: kokoro-g2p-parity.ts <data-dir> <corpus.tsv> <us|gb> <out.jsonl>');
  process.exit(1);
}

const read = (name: string) => JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
const g2p = new G2P({
  lexicon: new Lexicon({
    british: dialect === 'gb',
    data: { gold: read(`${dialect}_gold.json`), silver: read(`${dialect}_silver.json`) },
    letterToSound: new LetterToSound(readFileSync(kokoroLetterToSoundPath(dialect === 'gb'), 'utf8')),
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
