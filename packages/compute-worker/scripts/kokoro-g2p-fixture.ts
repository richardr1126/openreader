/**
 * Regenerates the small Misaki data subset the G2P tests run against, so the
 * ~14 MB of dictionaries and rules never have to be committed.
 *
 *   pnpm exec tsx packages/compute-worker/scripts/kokoro-g2p-fixture.ts <data-dir>
 *
 * `<data-dir>` holds the full us_gold.json, us_silver.json, gb_gold.json,
 * gb_silver.json, letter_to_sound.tsv and letter_to_sound_gb.tsv. Every sentence in
 * `tests/fixtures/kokoro-g2p/sentences.json` is phonemized against the full
 * data while each dictionary and rule-table read is recorded; the fixture is
 * every source entry those reads could have reached.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { G2P } from '../src/inference/kokoro/misaki/g2p';
import { LetterToSound } from '../src/inference/kokoro/misaki/letter-to-sound';
import { Lexicon, type GoldValue } from '../src/inference/kokoro/misaki/lexicon';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: kokoro-g2p-fixture.ts <data-dir>');
  process.exit(1);
}
const fixtureDir = path.resolve(process.cwd(), 'packages/compute-worker/tests/fixtures/kokoro-g2p');
const sentences = JSON.parse(readFileSync(path.join(fixtureDir, 'sentences.json'), 'utf8')) as {
  us: string[];
  gb: string[];
  lts: string[];
};

const read = (name: string) => readFileSync(path.join(dataDir, name), 'utf8');
const ltsSources = { us: read('letter_to_sound.tsv'), gb: read('letter_to_sound_gb.tsv') };

const touched = new Map<Map<unknown, unknown>, Set<unknown>>();
const originalGet = Map.prototype.get;
const originalHas = Map.prototype.has;
function record(map: Map<unknown, unknown>, key: unknown) {
  if (map === (touched as Map<unknown, unknown>)) return;
  let keys = originalGet.call(touched, map) as Set<unknown> | undefined;
  if (!keys) touched.set(map, (keys = new Set()));
  keys.add(key);
}
function recording<T>(run: () => T): T {
  Map.prototype.get = function get(this: Map<unknown, unknown>, key: unknown) {
    record(this, key);
    return originalGet.call(this, key);
  };
  Map.prototype.has = function has(this: Map<unknown, unknown>, key: unknown) {
    record(this, key);
    return originalHas.call(this, key);
  };
  try {
    return run();
  } finally {
    Map.prototype.get = originalGet;
    Map.prototype.has = originalHas;
  }
}

const lts = { us: new LetterToSound(ltsSources.us), gb: new LetterToSound(ltsSources.gb) };
type Internals = { golds: Map<string, GoldValue>; silvers: Map<string, string> };
type LtsInternals = { skeleton: Map<string, string>[]; stressPatterns: Map<string, string>[] };

function subsetFor(dialect: 'us' | 'gb', extra: string[]) {
  const gold = JSON.parse(read(`${dialect}_gold.json`)) as Record<string, GoldValue>;
  const silver = JSON.parse(read(`${dialect}_silver.json`)) as Record<string, string>;
  const lexicon = new Lexicon({ british: dialect === 'gb', data: { gold, silver }, letterToSound: lts[dialect] });
  const g2p = new G2P({ lexicon });
  recording(() => {
    for (const sentence of [...sentences[dialect], ...extra]) g2p.phonemize(sentence);
  });
  const internals = lexicon as unknown as Internals;
  // A grown key reaches back to its lower-case or capitalised source entry.
  const sources = (key: string) => {
    const lower = key.toLowerCase();
    return [key, lower, lower.charAt(0).toUpperCase() + lower.slice(1)];
  };
  const pick = <T>(source: Record<string, T>, map: Map<unknown, unknown>) => {
    const out: Record<string, T> = {};
    for (const key of touched.get(map) ?? []) {
      if (typeof key !== 'string') continue;
      for (const candidate of sources(key)) if (Object.hasOwn(source, candidate)) out[candidate] = source[candidate]!;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  // Dotted abbreviations are read from the whole gold table at construction.
  const goldSubset = pick(gold, internals.golds);
  for (const key of Object.keys(gold)) if (key.length > 1 && key.endsWith('.')) goldSubset[key] = gold[key]!;
  return { gold: goldSubset, silver: pick(silver, internals.silvers) };
}

// Every letter of every word a test sends straight to the rules.
const us = subsetFor('us', []);
const gb = subsetFor('gb', []);
recording(() => {
  for (const word of sentences.lts) lts.us.guess(word);
});

function ltsSubset(dialect: 'us' | 'gb'): string[] {
  const internals = lts[dialect] as unknown as LtsInternals;
  const lines: string[] = [];
  for (const line of ltsSources[dialect].split('\n')) {
    if (!line) continue;
    const [kind, key] = line.split('\t');
    if (kind === 'maxw') {
      lines.push(line);
      continue;
    }
    const level = Number.parseInt(kind!.slice(1), 10);
    const table = kind!.startsWith('s') ? internals.skeleton[level] : internals.stressPatterns[level];
    if (table && touched.get(table as Map<unknown, unknown>)?.has(key)) lines.push(line);
  }
  return lines;
}
const ltsLines = { us: ltsSubset('us'), gb: ltsSubset('gb') };

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(path.join(fixtureDir, 'us_gold.json'), `${JSON.stringify(us.gold)}\n`);
writeFileSync(path.join(fixtureDir, 'us_silver.json'), `${JSON.stringify(us.silver)}\n`);
writeFileSync(path.join(fixtureDir, 'gb_gold.json'), `${JSON.stringify(gb.gold)}\n`);
writeFileSync(path.join(fixtureDir, 'gb_silver.json'), `${JSON.stringify(gb.silver)}\n`);
writeFileSync(path.join(fixtureDir, 'letter_to_sound.tsv'), `${ltsLines.us.join('\n')}\n`);
writeFileSync(path.join(fixtureDir, 'letter_to_sound_gb.tsv'), `${ltsLines.gb.join('\n')}\n`);
console.log(
  `us gold ${Object.keys(us.gold).length}, us silver ${Object.keys(us.silver).length}, `
  + `gb gold ${Object.keys(gb.gold).length}, gb silver ${Object.keys(gb.silver).length}, lts ${ltsLines.us.length}/${ltsLines.gb.length} lines`,
);
