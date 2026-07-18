import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

const sectionFiles = [
  'AccountSettingsPanel.tsx',
  'AdminSettingsPanel.tsx',
  'AppearanceSettingsPanel.tsx',
  'DocumentSettingsPanel.tsx',
  'ProviderSettingsPanel.tsx',
];

describe('settings ownership', () => {
  test('keeps the public entry point and modal composition small', () => {
    const publicEntry = source('src/components/SettingsModal.tsx');
    const modal = source('src/components/settings/SettingsModal.tsx');
    const sidebarDialog = source('src/components/ui/sidebar-dialog.tsx');

    expect(publicEntry).toBe("export { SettingsModal, SettingsTrigger } from './settings/SettingsModal';\n");
    for (const sectionFile of sectionFiles) {
      expect(modal).toContain(`from './${sectionFile.replace('.tsx', '')}'`);
    }
    expect(modal).not.toContain("fetch('/api/");
    expect(modal).not.toContain('new EventSource');
    expect(modal.split('\n').length).toBeLessThan(250);
    expect(sidebarDialog).toContain("style={{ display: customContent ? 'none' : undefined }}");
  });

  test('prevents settings sections from importing one another', () => {
    for (const sectionFile of sectionFiles) {
      const sectionSource = source(`src/components/settings/${sectionFile}`);
      for (const otherSection of sectionFiles.filter((candidate) => candidate !== sectionFile)) {
        expect(sectionSource, `${sectionFile} imports ${otherSection}`).not.toContain(
          `./${otherSection.replace('.tsx', '')}`,
        );
      }
    }
  });

  test('gives long-running import and export work explicit cleanup owners', () => {
    const libraryImport = source('src/components/settings/useLibraryImport.ts');
    const accountExport = source('src/components/settings/useAccountExport.ts');

    expect(libraryImport).toContain('abortRef.current?.abort()');
    expect(libraryImport).toContain('useEffect(() => cancel, [cancel])');
    expect(accountExport).toContain('sourceRef.current?.close()');
    expect(accountExport).toContain('useEffect(() => closeSource, [closeSource])');
  });
});
