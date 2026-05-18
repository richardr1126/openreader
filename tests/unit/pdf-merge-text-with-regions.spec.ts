import { expect, test } from '@playwright/test';
import { mergeTextWithRegions } from '../../src/lib/server/pdf-layout/mergeTextWithRegions';

test.describe('mergeTextWithRegions', () => {
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
});
