import { describe, expect, it } from 'vitest';
import { DEFAULT_LIBRARY_DIR, parseLibraryRoots } from '@/lib/server/storage/library-mount';

describe('parseLibraryRoots', () => {
  it('splits on commas, colons and semicolons', () => {
    expect(parseLibraryRoots('/books, /comics:/papers;/notes', 'linux')).toEqual(['/books', '/comics', '/papers', '/notes']);
  });

  it('keeps Windows drive letters intact', () => {
    expect(parseLibraryRoots('C:\\books;D:\\comics,E:\\papers', 'win32')).toEqual(['C:\\books', 'D:\\comics', 'E:\\papers']);
  });

  it('falls back to the default folder', () => {
    expect(parseLibraryRoots(' , ', 'linux')).toEqual([DEFAULT_LIBRARY_DIR]);
  });
});
