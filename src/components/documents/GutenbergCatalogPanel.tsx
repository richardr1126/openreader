'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useDocuments } from '@/contexts/DocumentContext';
import {
  importGutenbergBook,
  searchGutenberg,
  type GutenbergBook,
} from '@/lib/client/api/documents';
import { Button, SearchField, Select, type SelectOption } from '@/components/ui';
import { EPUBIcon, RefreshIcon } from '@/components/icons/Icons';

type ImportState = 'importing' | 'added';

/** The same languages the iOS app offers, which between them cover nearly all
 * of the catalog. English is the default there too: unfiltered, the popular
 * list opens on a mix most readers cannot read. */
const LANGUAGE_CODES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'zh', 'ja'] as const;

function languageOptions(): SelectOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: 'language' });
  } catch {
    names = null;
  }
  return [
    { value: '', label: 'All languages' },
    ...LANGUAGE_CODES.map((code) => ({ value: code, label: names?.of(code) ?? code })),
  ];
}

type SearchRequest = { search: string; language: string; page: number };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Search Project Gutenberg and add books to the library.
 *
 * The dialog stays open while a book imports, unlike the other tabs, because
 * picking several books from one search is the usual way this gets used; each
 * row carries its own state instead of the upload status bar, which tracks
 * files the browser is sending and has nothing to show for a server download.
 */
export function GutenbergCatalogPanel({ folderId }: { folderId?: string }) {
  const { refreshDocuments } = useDocuments();
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState<string>('en');
  const [languages] = useState(languageOptions);
  // What the list shows, so "Load more" pages the search that produced it
  // rather than whatever has since been typed into the box.
  const [shown, setShown] = useState<Omit<SearchRequest, 'page'>>({ search: '', language: 'en' });
  const [books, setBooks] = useState<GutenbergBook[]>([]);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  // The request that failed, so "Try Again" repeats it — a failed "Load more"
  // retries that page instead of starting over from whatever is in the box.
  const [failed, setFailed] = useState<(SearchRequest & { message: string }) | null>(null);
  const [imports, setImports] = useState<Record<number, ImportState>>({});
  const searchRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async ({ search, language, page: nextPage }: SearchRequest) => {
    searchRef.current?.abort();
    const controller = new AbortController();
    searchRef.current = controller;
    setLoading(true);
    setFailed(null);
    try {
      const result = await searchGutenberg(search, nextPage, { signal: controller.signal, language });
      setBooks((previous) => nextPage === 1 ? result.books : [...previous, ...result.books]);
      setPage(nextPage);
      setShown({ search, language });
      setHasNextPage(result.hasNextPage);
    } catch (err) {
      if (isAbortError(err)) return;
      setFailed({
        search,
        language,
        page: nextPage,
        message: err instanceof Error ? err.message : 'Failed to search Project Gutenberg',
      });
    } finally {
      if (searchRef.current === controller) setLoading(false);
    }
  }, []);

  // An empty search lists the most downloaded books, which is a better
  // opening screen than an empty box.
  useEffect(() => {
    void runSearch({ search: '', language: 'en', page: 1 });
    return () => searchRef.current?.abort();
  }, [runSearch]);

  const addBook = async (book: GutenbergBook) => {
    setImports((previous) => ({ ...previous, [book.id]: 'importing' }));
    try {
      await importGutenbergBook(book.id, { folderId });
      setImports((previous) => ({ ...previous, [book.id]: 'added' }));
      toast.success(`Added "${book.title}"`);
      void refreshDocuments();
    } catch (err) {
      setImports((previous) => {
        const next = { ...previous };
        delete next[book.id];
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'Failed to import the book');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 animate-fade-in">
      <form
        className="flex shrink-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch({ search: query, language, page: 1 });
        }}
      >
        <SearchField
          aria-label="Search Project Gutenberg"
          placeholder="Search by title or author"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="flex-1 py-1.5"
          inputClassName="text-sm"
        />
        <div className="w-36 shrink-0">
          <Select
            value={languages.find((option) => option.value === language)}
            options={languages}
            onChange={(option) => {
              setLanguage(option.value);
              // Like iOS, a new language applies straight away, to the search
              // the list is showing rather than to unsubmitted text in the box.
              void runSearch({ search: shown.search, language: option.value, page: 1 });
            }}
          />
        </div>
        <Button type="submit" variant="primary" disabled={loading}>Search</Button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface-sunken" aria-busy={loading}>
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-danger">{failed.message}</p>
            <button
              type="button"
              onClick={() => void runSearch(failed)}
              className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              <RefreshIcon className="h-3 w-3" /> Try Again
            </button>
          </div>
        ) : books.length === 0 && !loading ? (
          <p className="flex h-full items-center justify-center p-6 text-sm text-soft">No books found</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Project Gutenberg books">
            {books.map((book) => {
              const state = imports[book.id];
              return (
                <li key={book.id} className="flex items-center gap-3 px-3 py-2">
                  {book.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={book.coverUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-12 w-8 shrink-0 rounded-sm bg-offbase object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-8 shrink-0 items-center justify-center rounded-sm bg-offbase">
                      <EPUBIcon className="h-4 w-4 text-soft" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={book.title}>{book.title}</p>
                    <p className="truncate text-xs text-soft">{book.authors.join(', ') || 'Unknown author'}</p>
                  </div>
                  <Button
                    size="sm"
                    variant={state === 'added' ? 'secondary' : 'outline'}
                    disabled={state !== undefined}
                    onClick={() => void addBook(book)}
                    aria-label={`Add ${book.title}`}
                  >
                    {state === 'importing' ? 'Adding…' : state === 'added' ? 'Added' : 'Add'}
                  </Button>
                </li>
              );
            })}
            {loading ? (
              <li className="flex items-center justify-center gap-2 p-4 text-xs text-soft">
                <RefreshIcon className="h-4 w-4 animate-spin text-accent" />
                <span>Searching… A search nobody has made recently can take a minute or two.</span>
              </li>
            ) : hasNextPage ? (
              <li className="flex justify-center p-3">
                <Button size="sm" variant="secondary" onClick={() => void runSearch({ ...shown, page: page + 1 })}>Load more</Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <p className="shrink-0 text-[11px] leading-normal text-soft">
        Free public domain ebooks from{' '}
        <a href="https://www.gutenberg.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">Project Gutenberg</a>
        , searched with{' '}
        <a href="https://github.com/garethbjohnson/gutendex" target="_blank" rel="noreferrer" className="text-accent hover:underline">Gutendex</a>.
        {' '}Public domain in the United States; copyright may differ elsewhere.
      </p>
    </div>
  );
}
