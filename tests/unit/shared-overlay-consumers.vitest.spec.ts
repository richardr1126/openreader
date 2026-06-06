import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const STANDARD_OVERLAY_CONSUMERS = [
  'src/components/admin/AdminProvidersPanel.tsx',
  'src/components/AudiobookExportModal.tsx',
  'src/components/ColorPicker.tsx',
  'src/components/doclist/window/FinderSidebar.tsx',
  'src/components/documents/DocumentHeaderMenu.tsx',
  'src/components/player/Navigator.tsx',
  'src/components/player/SpeedControl.tsx',
];

describe('shared overlay consumers', () => {
  test('standard menus and popovers do not compose Headless UI directly', () => {
    for (const relativePath of STANDARD_OVERLAY_CONSUMERS) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).not.toContain("from '@headlessui/react'");
    }
  });

  test('shared overlay primitives own standard composition', () => {
    const menuSource = readFileSync(resolve(process.cwd(), 'src/components/ui/menu.tsx'), 'utf8');
    const popoverSource = readFileSync(resolve(process.cwd(), 'src/components/ui/popover.tsx'), 'utf8');
    expect(menuSource).toContain('export const MenuRoot');
    expect(menuSource).toContain('export function MenuTransition');
    expect(popoverSource).toContain('export const PopoverRoot');
    expect(popoverSource).toContain('export function PopoverIconTrigger');
  });
});
