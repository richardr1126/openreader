import { describe, expect, test } from 'vitest';
import { buildPdfPageSourceUnits } from '@openreader/tts/pdf-sources';
import { mergeTextWithRegions, type LayoutRegion } from '../../../src/inference/pdf/document-layout';

type Box = [number, number, number, number];
// Coordinates as parse.ts passes them, at the 1.5 layout render scale.
const S = 1.5;
const box = (x0: number, y0: number, x1: number, y1: number): Box => [x0 * S, y0 * S, x1 * S, y1 * S];
const item = (text: string, x: number, y: number, width: number, height = 11) => (
  { text, x: x * S, y: y * S, width: width * S, height: height * S }
);

describe('mergeTextWithRegions', () => {
  test('assigns text items to containing regions by centroid and joins in reading order', () => {
    const regions = [
      { bbox: [0, 0, 100, 50] as [number, number, number, number], label: 'text' as const },
      { bbox: [0, 50, 100, 100] as [number, number, number, number], label: 'figure_title' as const },
    ];

    const textItems = [
      { text: 'world', x: 40, y: 20, width: 20, height: 8 },
      { text: 'hello', x: 10, y: 20, width: 20, height: 8 },
      { text: 'Figure', x: 10, y: 70, width: 24, height: 8 },
      { text: '1.2', x: 40, y: 70, width: 10, height: 8 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('hello world');
    expect(merged[1].text).toBe('Figure 1.2');
  });

  test('drops text whose centroid is outside every region', () => {
    const regions = [
      { bbox: [0, 0, 50, 50] as [number, number, number, number], label: 'text' as const },
    ];
    const textItems = [
      { text: 'inside', x: 10, y: 10, width: 10, height: 8 },
      { text: 'outside', x: 80, y: 80, width: 12, height: 8 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('inside');
  });

  test('keeps decorative drop caps attached to the same line when boxes overlap vertically', () => {
    const regions = [
      { bbox: [0, 0, 200, 120] as [number, number, number, number], label: 'text' as const },
    ];

    const textItems = [
      { text: 'I', x: 0, y: 10, width: 12, height: 60 },
      { text: 't’s funny,', x: 12, y: 40, width: 50, height: 12 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('It’s funny,');
  });

  test('keeps selectable text inside detected graphic regions under the graphic kind', () => {
    const regions: LayoutRegion[] = [
      { bbox: box(55, 100, 400, 120), label: 'paragraph_title' },
      { bbox: box(55, 130, 400, 160), label: 'text' },
      { bbox: box(55, 188, 260, 202), label: 'figure_title' },
      { bbox: box(50, 186, 550, 360), label: 'table' },
      { bbox: box(70, 420, 510, 660), label: 'chart' },
      { bbox: box(70, 670, 260, 700), label: 'image' },
      { bbox: box(300, 670, 420, 760), label: 'image' },
      { bbox: box(430, 670, 550, 760), label: 'seal' },
      { bbox: box(50, 20, 550, 40), label: 'header' },
    ];
    const textItems = [
      item('Running header', 55, 26, 120, 9),
      item('Quarterly overview', 55, 104, 140, 15),
      item('The team measured three stations.', 55, 134, 300),
      // The caption sits inside the table bounds and keeps its own block.
      item('Table 1. Field observations', 57, 190, 190),
      // Adjacent rows with a bold, larger header row.
      item('Station', 70, 214, 50, 12),
      item('Sample', 300, 214, 50, 12),
      item('Birch', 70, 228, 40),
      item('Spruce log', 300, 228, 60),
      item('Cedar', 70, 242, 40),
      item('Willow log', 300, 242, 60),
      item('April readings', 80, 430, 80),
      item('Oak', 120, 640, 25),
      item('North Gate', 80, 680, 60),
      item('Verification code', 440, 700, 90),
      item('Unclaimed margin note', 560, 500, 40),
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged.map((block) => [block.region.label, block.text])).toEqual([
      ['header', 'Running header'],
      ['paragraph_title', 'Quarterly overview'],
      ['text', 'The team measured three stations.'],
      ['figure_title', 'Table 1. Field observations'],
      ['table', 'Station Sample Birch Spruce log Cedar Willow log'],
      ['chart', 'April readings Oak'],
      ['image', 'North Gate'],
      ['seal', 'Verification code'],
      // Image-only regions stay empty and last.
      ['image', ''],
    ]);

    const page = {
      blocks: merged.map((block, readingOrder) => ({
        id: `b${readingOrder + 1}`, kind: block.region.label, text: block.text, fragments: [{ readingOrder }],
      })),
    };
    const spoken = (skip: string[]) => buildPdfPageSourceUnits(page, 1, skip).map((unit) => unit.text);
    const defaults = ['header', 'footer', 'footnote', 'vision_footnote'];
    expect(spoken(defaults)).toEqual([
      'Quarterly overview',
      'The team measured three stations.',
      'Table 1. Field observations',
      'Station Sample Birch Spruce log Cedar Willow log',
      'April readings Oak',
      'North Gate',
      'Verification code',
    ]);
    for (const kind of ['table', 'chart', 'image', 'seal'] as const) {
      const kept = merged.filter((block) => block.text && block.region.label !== 'header' && block.region.label !== kind);
      expect(spoken([...defaults, kind])).toEqual(kept.map((block) => block.text));
    }
    expect(spoken([])[0]).toBe('Running header');
  });

  test('assigns text shared by overlapping graphic regions to one block', () => {
    const regions: LayoutRegion[] = [
      { bbox: box(0, 0, 300, 300), label: 'chart', confidence: 0.6 },
      { bbox: box(50, 50, 150, 150), label: 'image', confidence: 0.6 },
      { bbox: box(40, 40, 160, 160), label: 'table', confidence: 0.9 },
    ];
    const merged = mergeTextWithRegions(regions, [
      item('Inner label', 60, 60, 50),
      item('Outer label', 200, 250, 50),
    ]);
    expect(merged.map((block) => [block.region.label, block.text])).toEqual([
      ['table', 'Inner label'],
      ['chart', 'Outer label'],
      ['image', ''],
    ]);
  });
});
