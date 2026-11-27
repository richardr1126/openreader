import { describe, expect, test } from 'vitest';
import { OPS } from 'pdfjs-dist';
import { collectGlyphChars, runCharEdges } from '../../src/lib/client/pdf/glyph-edges';

const glyph = (unicode: string, width: number, isSpace = false) => ({ unicode, width, isSpace });

function operatorList(ops: Array<[number, unknown[] | null]>) {
  return { fnArray: ops.map(([fn]) => fn), argsArray: ops.map(([, args]) => args) };
}

// 10 pt text at x = 100, y = 700, in a font whose glyph widths are per 1000 units.
const textOps = (glyphs: unknown[], extra: Array<[number, unknown[]]> = []) => operatorList([
  [OPS.beginText, null],
  [OPS.setFont, ['F1', 10]],
  ...extra,
  [OPS.setTextMatrix, [1, 0, 0, 1, 100, 700]],
  [OPS.showText, [glyphs]],
]);

const fontInfo = () => ({ fontMatrix: [0.001, 0, 0, 0.001, 0, 0] });
const round = (values: ArrayLike<number>) => Array.from(values, (value) => Math.round(value * 1000) / 1000);

describe('PDF glyph edges', () => {
  test('places characters from glyph advances and kerning', () => {
    const chars = collectGlyphChars(
      textOps([glyph('H', 700), glyph('i', 300), -500, glyph('t', 400), glyph('o', 500)]),
      fontInfo,
    );

    expect(chars.map(({ ch, x0, x1, y }) => [ch, x0, x1, y])).toEqual([
      ['H', 100, 107, 700],
      ['i', 107, 110, 700],
      ['t', 115, 119, 700],
      ['o', 119, 124, 700],
    ]);
  });

  test('applies character spacing, word spacing and horizontal scaling', () => {
    const chars = collectGlyphChars(
      textOps(
        [glyph('a', 500), glyph(' ', 250, true), glyph('b', 500)],
        [[OPS.setCharSpacing, [1]], [OPS.setWordSpacing, [2]], [OPS.setHScale, [50]]],
      ),
      fontInfo,
    );

    // Each advance is (width + spacing) * 0.5: a = 5 + 1, space = 2.5 + 1 + 2.
    expect(chars.map(({ ch, x0, x1 }) => [ch, x0, x1])).toEqual([
      ['a', 100, 102.5],
      [' ', 103, 104.25],
      ['b', 105.75, 108.25],
    ]);
  });

  test('maps a run to fractions of its width, spanning a space pdf.js inserted', () => {
    const chars = collectGlyphChars(
      textOps([glyph('H', 700), glyph('i', 300), -500, glyph('t', 400), glyph('o', 500)]),
      fontInfo,
    );
    const edges = runCharEdges({ str: 'Hi to', transform: [10, 0, 0, 10, 100, 700], width: 24 }, chars);

    expect(round(edges!)).toEqual(round([
      0, 7 / 24,
      7 / 24, 10 / 24,
      10 / 24, 15 / 24,
      15 / 24, 19 / 24,
      19 / 24, 1,
    ]));
  });

  test('keeps the text-layer box when the glyphs do not match the run', () => {
    const chars = collectGlyphChars(textOps([glyph('H', 700), glyph('i', 300)]), fontInfo);

    expect(runCharEdges({ str: 'Hx', transform: [10, 0, 0, 10, 100, 700], width: 10 }, chars)).toBeNull();
    expect(runCharEdges({ str: 'Hi', transform: [0, 10, -10, 0, 100, 700], width: 10 }, chars)).toBeNull();
  });
});
