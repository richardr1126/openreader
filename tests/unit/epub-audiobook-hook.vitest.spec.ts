import { describe, expect, test } from 'vitest';

import {
  filterNonEmptySpineTextEntries,
  resolveLoadedSpineSectionDocument,
} from '../../src/hooks/epub/useEPUBAudiobook';

describe('EPUB audiobook hook helpers', () => {
  test('resolveLoadedSpineSectionDocument prefers ownerDocument when available', () => {
    const ownerDocument = { body: { textContent: 'from ownerDocument' } } as unknown as Document;
    const loaded = { ownerDocument } as unknown;
    const section = { document: { body: { textContent: 'from section' } } as unknown as Document };
    expect(resolveLoadedSpineSectionDocument(loaded, section)).toBe(ownerDocument);
  });

  test('resolveLoadedSpineSectionDocument falls back to section.document', () => {
    const sectionDocument = { body: { textContent: 'from section' } } as unknown as Document;
    const section = { document: sectionDocument };
    expect(resolveLoadedSpineSectionDocument({ foo: 'bar' }, section)).toBe(sectionDocument);
  });

  test('resolveLoadedSpineSectionDocument returns null with no loaded value and no section doc', () => {
    expect(resolveLoadedSpineSectionDocument(null, {})).toBeNull();
    expect(resolveLoadedSpineSectionDocument(undefined, {})).toBeNull();
  });

  test('filterNonEmptySpineTextEntries removes blank and whitespace-only entries', () => {
    const entries = [
      { text: 'Chapter one', href: 'c1.xhtml' },
      { text: '   ', href: 'blank.xhtml' },
      { text: '\n\t', href: 'ws.xhtml' },
      { text: 'Chapter two', href: 'c2.xhtml' },
    ];

    expect(filterNonEmptySpineTextEntries(entries)).toEqual([
      { text: 'Chapter one', href: 'c1.xhtml' },
      { text: 'Chapter two', href: 'c2.xhtml' },
    ]);
  });
});
