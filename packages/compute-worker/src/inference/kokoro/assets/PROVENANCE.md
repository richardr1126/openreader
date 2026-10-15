# Misaki TypeScript port: provenance and modifications

`../misaki/` is a TypeScript port of the Misaki Swift sources vendored by the
OpenReader iOS app (`OpenReaderKit/Sources/Misaki`), which came from
kokoro-swift commit `20bf04c506e913ff129d7d2229398180ba24c690`, itself a port
of hexgrad/misaki. Apache-2.0; see `LICENSE.txt`. This file records the
changes, per section 4(b).

## Inherited from the iOS port

These were already in the Swift sources and are kept unchanged. The iOS
`PROVENANCE.md` gives the full reasoning.

- `tokenize` glues an apostrophe onto the word it touches ("Richard's").
- An intra-word hyphen is tagged `HYPH`, so compounds are not read with a pause.
- Symbols the lexicon can name (`&`, `%`, `+`, `@`) get past the punctuation
  branch.
- A failed lookup is retried with diacritics folded ("café").
- A unit abbreviation after a number is expanded ("5 km").
- A word that no dictionary holds goes to `LetterToSound` instead of espeak.

## Made in this port

- **Tagging.** Node has no `NLTagger`. `tagger.ts` splits words the way the
  Swift code expects and asks `compromise` (MIT) for each word's part of speech,
  mapped to Penn tags by character offset. compromise's own tokens are not
  used. A compromise participle maps to `VBN`; the mapping is specific to compromise. Tagging
  can therefore differ from iOS on heteronyms ("read", "live") in some
  sentences.
- **Dotted abbreviations.** A dictionary entry ending in a full stop ("Mr.",
  "Dr.", "etc.") keeps its full stop when whitespace follows, as spaCy's
  tokenizer exceptions do upstream. The phonemes match iOS.
- **Initialisms.** `getNNP` promotes the last secondary stress (upstream's
  `rsplit`). The Swift port promotes the first.
- **Unknown marker.** The engine builds `G2P` with `unk: ''`, as Kokoro's
  `KPipeline` does. An unresolvable token ("St.", "Ft.") is silent rather than
  marked.
- **Numbers.** `NumberToWords` uses `BigInt` for the large scales. The output
  is unchanged.
