import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const STANDARD_FORM_CONSUMERS = [
  'src/app/(app)/signin/page.tsx',
  'src/app/(app)/signup/page.tsx',
  'src/components/PrivacyModal.tsx',
  'src/components/SettingsModal.tsx',
  'src/components/admin/AdminFeaturesPanel.tsx',
  'src/components/admin/AdminProvidersPanel.tsx',
  'src/components/documents/DocumentSelectionModal.tsx',
];

describe('shared form-control consumers', () => {
  test('standard forms use shared inputs, textareas, and checkboxes', () => {
    for (const relativePath of STANDARD_FORM_CONSUMERS) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/<(input|textarea)\b/);
      expect(source, relativePath).not.toContain('inputClass');
    }
  });

  test('auth pages use the shared inline button', () => {
    for (const relativePath of [
      'src/app/(app)/signin/page.tsx',
      'src/app/(app)/signup/page.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).toContain('<InlineButton');
      expect(source, relativePath).not.toMatch(/<button\b/);
    }
  });

  test('shared primitives own standard form-control chrome', () => {
    const inputSource = readFileSync(resolve(process.cwd(), 'src/components/ui/input.tsx'), 'utf8');
    const checkboxSource = readFileSync(resolve(process.cwd(), 'src/components/ui/checkbox.tsx'), 'utf8');
    expect(inputSource).toContain('inputStyles');
    expect(inputSource).toContain('export function Textarea');
    expect(checkboxSource).toContain('checkboxClass');
    expect(checkboxSource).toContain('export const Checkbox');
  });
});
