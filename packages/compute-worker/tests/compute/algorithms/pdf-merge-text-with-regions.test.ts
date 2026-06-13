import { describe, expect, test } from 'vitest';
import { mergeTextWithRegions } from '../../../src/inference/pdf/document-layout';

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
});
