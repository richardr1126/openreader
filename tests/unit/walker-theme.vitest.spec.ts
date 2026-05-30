import { describe, expect, test } from 'vitest';

import { buildWalkerThemeRules } from '../../src/lib/client/epub/walker-theme';

describe('walker theme rules', () => {
  test('always includes foreground/background colors', () => {
    const rules = buildWalkerThemeRules({
      foreground: 'rgb(1, 2, 3)',
      base: 'rgb(9, 8, 7)',
    });

    expect(rules.body.color).toBe('rgb(1, 2, 3)');
    expect(rules.body['background-color']).toBe('rgb(9, 8, 7)');
  });

  test('includes typography metrics when provided', () => {
    const rules = buildWalkerThemeRules({
      foreground: '#111',
      base: '#fff',
      fontFamily: 'Georgia, serif',
      fontSize: '18px',
      lineHeight: '1.7',
      fontWeight: '400',
      letterSpacing: '0.01em',
      wordSpacing: '0.03em',
    });

    expect(rules.body['font-family']).toBe('Georgia, serif');
    expect(rules.body['font-size']).toBe('18px');
    expect(rules.body['line-height']).toBe('1.7');
    expect(rules.body['font-weight']).toBe('400');
    expect(rules.body['letter-spacing']).toBe('0.01em');
    expect(rules.body['word-spacing']).toBe('0.03em');
  });

  test('omits typography keys when missing', () => {
    const rules = buildWalkerThemeRules({
      foreground: '#111',
      base: '#fff',
      fontFamily: '',
      lineHeight: '',
    });

    expect('font-family' in rules.body).toBe(false);
    expect('line-height' in rules.body).toBe(false);
  });
});
