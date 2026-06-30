import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const STANDARD_SELECT_CONSUMERS = [
  'src/components/SettingsModal.tsx',
  'src/components/documents/DocumentSettings.tsx',
  'src/components/admin/AdminFeaturesPanel.tsx',
  'src/components/admin/AdminProvidersPanel.tsx',
];

describe('shared Select consumers', () => {
  test('standard settings dropdowns use the high-level UI primitive', () => {
    for (const relativePath of STANDARD_SELECT_CONSUMERS) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).toContain('<Select');
      expect(source, relativePath).not.toContain('<Listbox');
      expect(source, relativePath).not.toContain('<SharedListboxButton');
      expect(source, relativePath).not.toContain('<SharedListboxOptions');
      expect(source, relativePath).not.toContain('<SharedListboxOption');
    }
  });

  test('the shared Select owns standard dropdown chrome', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/ui/select.tsx'), 'utf8');
    expect(source).toContain('ChevronUpDownIcon');
    expect(source).toContain('CheckIcon');
    expect(source).toContain('<Transition');
  });

  test('audiobook export delegates voice dropdown rendering', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/AudiobookExportModal.tsx'), 'utf8');
    expect(source).toContain('<VoicesControlBase');
    expect(source).not.toContain('<Listbox');
    expect(source).not.toContain('<SharedListboxButton');
    expect(source).not.toContain('<SharedListboxOptions');
    expect(source).not.toContain('<SharedListboxOption');
  });
});
