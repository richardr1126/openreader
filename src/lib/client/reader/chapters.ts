/**
 * Contents derived from the playback plan.
 *
 * The plan is a flat run of sentences, but every segment carries the locator
 * of what it was read from, and a change of owner is a place a chapter may
 * begin: a new EPUB resource, a new PDF page, a new Markdown block. Those runs
 * are the seekable grid. A document's own outline (EPUB table of contents, PDF
 * outline, Markdown headings) only names and groups runs; it never moves a
 * boundary to somewhere there is no segment. Every chapter therefore starts at
 * a real plan ordinal, so choosing one is an ordinary seek.
 */
import type { TTSSegmentLocator } from '@openreader/tts/types';

export type ChapterSegment = {
  ordinal: number;
  text: string;
  ownerLocator: TTSSegmentLocator | null;
};

export type OutlineTarget =
  | { readerType: 'epub'; href: string }
  | { readerType: 'pdf'; page: number }
  | { readerType: 'html'; location: string };

export type OutlineEntry = {
  title: string;
  target: OutlineTarget;
  /** Nesting in the source's contents; zero is top level. */
  depth: number;
};

export type ReaderChapter = {
  title: string;
  startOrdinal: number;
  endOrdinal: number;
  depth: number;
};

/** Inferred titles longer than this read as prose, not a heading. */
const INFERRED_TITLE_LIMIT = 64;

type Run = {
  owner: string | null;
  start: number;
  end: number;
  firstText: string;
  locator: TTSSegmentLocator | null;
};

export function normalizeEpubHref(href: string): string {
  const path = href.split('#')[0] ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the raw path when the EPUB contains malformed escapes.
  }
  return decoded.replace(/^(\.\.\/|\.\/|\/)+/, '');
}

/**
 * TOC hrefs are relative to the navigation document while spine hrefs are
 * relative to the package, so paths match by suffix after dropping fragments.
 */
export function epubHrefsMatch(left: string, right: string): boolean {
  const a = normalizeEpubHref(left);
  const b = normalizeEpubHref(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function ownerOf(locator: TTSSegmentLocator | null): string | null {
  if (!locator) return null;
  if (locator.readerType === 'epub' && locator.spineHref) return `epub:${normalizeEpubHref(locator.spineHref)}`;
  if (locator.readerType === 'pdf' && typeof locator.page === 'number') return `pdf:${locator.page}`;
  if (locator.readerType === 'html' && locator.location) return `html:${locator.location}`;
  return null;
}

function targetMatchesRun(target: OutlineTarget, run: Run): boolean {
  const locator = run.locator;
  if (!locator) return false;
  if (target.readerType === 'epub') {
    return locator.readerType === 'epub' && !!locator.spineHref && epubHrefsMatch(target.href, locator.spineHref);
  }
  if (target.readerType === 'pdf') return locator.readerType === 'pdf' && locator.page === target.page;
  return locator.readerType === 'html' && locator.location === target.location;
}

function runsOf(segments: readonly ChapterSegment[]): Run[] {
  const runs: Run[] = [];
  for (const segment of segments) {
    const owner = ownerOf(segment.ownerLocator);
    const last = runs[runs.length - 1];
    if (last && last.owner === owner) {
      last.end = segment.ordinal;
    } else {
      runs.push({
        owner,
        start: segment.ordinal,
        end: segment.ordinal,
        firstText: segment.text,
        locator: segment.ownerLocator,
      });
    }
  }
  return runs;
}

type Mark = { run: number; title: string; depth: number };

function marksFrom(outline: readonly OutlineEntry[], runs: Run[]): Mark[] {
  const marks: Mark[] = [];
  for (const entry of outline) {
    const title = entry.title.trim();
    if (!title) continue;
    const run = runs.findIndex((candidate) => targetMatchesRun(entry.target, candidate));
    // Entries pointing where no text came from are dropped rather than snapped
    // to a neighbour; several entries on one run collapse to the first.
    if (run < 0) continue;
    const last = marks[marks.length - 1];
    if (last && run <= last.run) continue;
    marks.push({ run, title, depth: Math.max(0, Math.floor(entry.depth)) });
  }
  // Rank surviving depths so dropped parent entries do not leave orphan indents.
  const levels = Array.from(new Set(marks.map((mark) => mark.depth))).sort((a, b) => a - b);
  const rank = new Map(levels.map((level, index) => [level, index]));
  return marks.map((mark) => ({ ...mark, depth: rank.get(mark.depth) ?? 0 }));
}

function inferredTitle(run: Run, number: number, documentTitle: string): string {
  const locator = run.locator;
  if (locator?.readerType === 'pdf' && typeof locator.page === 'number') return `Page ${locator.page}`;
  if (locator?.readerType === 'epub') {
    const heading = run.firstText.replace(/\s+/g, ' ').trim();
    return heading && heading.length <= INFERRED_TITLE_LIMIT ? heading : `Chapter ${number}`;
  }
  return documentTitle;
}

export function deriveChapters(
  segments: readonly ChapterSegment[],
  outline: readonly OutlineEntry[],
  documentTitle: string,
): ReaderChapter[] {
  const runs = runsOf(segments);
  if (runs.length === 0) return [];
  const lastOrdinal = runs[runs.length - 1].end;
  const marks = marksFrom(outline, runs);

  if (marks.length === 0) {
    // Markdown and plain text flow as one document; every block is its own
    // run, which is no contents at all.
    if (runs[0].locator?.readerType === 'html' || runs[0].locator === null) {
      return [{ title: documentTitle, startOrdinal: runs[0].start, endOrdinal: lastOrdinal, depth: 0 }];
    }
    return runs.map((run, index) => ({
      title: inferredTitle(run, index + 1, documentTitle),
      startOrdinal: run.start,
      endOrdinal: run.end,
      depth: 0,
    }));
  }

  const chapters: ReaderChapter[] = [];
  // Text before the first mark is front matter the outline did not name. It is
  // still read aloud, so it keeps an entry.
  if (marks[0].run > 0) {
    chapters.push({
      title: inferredTitle(runs[0], 1, documentTitle),
      startOrdinal: runs[0].start,
      endOrdinal: runs[marks[0].run - 1].end,
      depth: 0,
    });
  }
  marks.forEach((mark, index) => {
    const next = marks[index + 1];
    chapters.push({
      title: mark.title,
      startOrdinal: runs[mark.run].start,
      endOrdinal: next ? runs[next.run - 1].end : lastOrdinal,
      depth: mark.depth,
    });
  });
  return chapters;
}

/** The chapter containing an ordinal, or null before a selection exists. */
export function chapterIndexForOrdinal(
  chapters: readonly ReaderChapter[],
  ordinal: number | null,
): number {
  if (ordinal === null) return -1;
  return chapters.findIndex((chapter) => ordinal >= chapter.startOrdinal && ordinal <= chapter.endOrdinal);
}
