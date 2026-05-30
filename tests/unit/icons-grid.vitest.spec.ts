import { describe, expect, test } from 'vitest';
import { iconsGridStyle, maxColumnsForIconGrid } from '../../src/components/doclist/views/iconsGrid';

describe('icons grid layout', () => {
  test('calculates max columns from width and icon size', () => {
    expect(maxColumnsForIconGrid('md', 136)).toBe(1);
    expect(maxColumnsForIconGrid('md', 300)).toBe(2);
    expect(maxColumnsForIconGrid('md', 1000)).toBe(6);
  });

  test('uses auto-fit by default when single-row suppression is off', () => {
    const style = iconsGridStyle('md', 4);
    expect(style.gridTemplateColumns).toContain('repeat(auto-fit');
    expect(style.gridTemplateColumns).toContain('1fr');
    expect(style.justifyContent).toBeUndefined();
  });

  test('disables stretch when single-row suppression is on', () => {
    const style = iconsGridStyle('md', 4, { suppressSingleRowStretch: true });
    expect(style.gridTemplateColumns).toContain('repeat(auto-fill');
    expect(style.gridTemplateColumns).not.toContain('1fr');
    expect(style.justifyContent).toBe('start');
  });
});
