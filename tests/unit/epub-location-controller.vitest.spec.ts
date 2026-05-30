import { describe, expect, test } from 'vitest';

import {
  isDirectionalEpubLocation,
  shouldNavigateToDifferentCfi,
  shouldPersistEpubLocation,
} from '../../src/hooks/epub/useEPUBLocationController';

describe('EPUB location controller helpers', () => {
  test('detects directional locations', () => {
    expect(isDirectionalEpubLocation('next')).toBe(true);
    expect(isDirectionalEpubLocation('prev')).toBe(true);
    expect(isDirectionalEpubLocation('epubcfi(/6/2!/4:0)')).toBe(false);
    expect(isDirectionalEpubLocation(4)).toBe(false);
  });

  test('navigates only when target CFI differs from rendered CFI', () => {
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/4!/4:0)', 'epubcfi(/6/2!/4:0)')).toBe(true);
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/2!/4:0)', 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi('next', 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi(3, 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/4!/4:0)', undefined)).toBe(false);
  });

  test('persists progress only after first real location and with a document id', () => {
    expect(shouldPersistEpubLocation('doc-1', 2)).toBe(true);
    expect(shouldPersistEpubLocation('doc-1', 'epubcfi(/6/2!/4:0)')).toBe(true);
    expect(shouldPersistEpubLocation('doc-1', 1)).toBe(false);
    expect(shouldPersistEpubLocation(undefined, 2)).toBe(false);
  });
});
