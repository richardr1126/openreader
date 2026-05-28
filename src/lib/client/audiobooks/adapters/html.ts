import type { AudiobookSourceAdapter, PreparedAudiobookChapter } from '@/lib/client/audiobooks/pipeline';
import { normalizeTextForTts } from '@/lib/shared/nlp';
import type { HtmlBlock } from '@/lib/client/html/blocks';

interface HtmlAudiobookAdapterOptions {
  blocks: HtmlBlock[];
  isTxt: boolean;
  maxBlockLength?: number;
  /**
   * For markdown: any heading with `headingLevel <= chapterHeadingLevel`
   * begins a new chapter. Defaults to 2 (h1/h2).
   */
  chapterHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Fallback chapter size (in blocks) used when no headings exist (MD) or for
   * TXT documents.
   */
  fallbackBlocksPerChapter?: number;
}

interface ChapterDraft {
  title: string;
  blocks: HtmlBlock[];
}

function buildChapterDrafts({
  blocks,
  isTxt,
  chapterHeadingLevel = 2,
  fallbackBlocksPerChapter = 50,
}: HtmlAudiobookAdapterOptions): ChapterDraft[] {
  if (!blocks.length) return [];

  if (!isTxt) {
    const hasChapterHeadings = blocks.some(
      (b) => b.kind === 'heading' && (b.headingLevel ?? 6) <= chapterHeadingLevel,
    );

    if (hasChapterHeadings) {
      const drafts: ChapterDraft[] = [];
      let current: ChapterDraft | null = null;
      const prelude: HtmlBlock[] = [];

      for (const block of blocks) {
        const isChapterStart =
          block.kind === 'heading' && (block.headingLevel ?? 6) <= chapterHeadingLevel;

        if (isChapterStart) {
          if (current) drafts.push(current);
          current = {
            title: block.headingText?.trim() || `Chapter ${drafts.length + 1}`,
            blocks: [block],
          };
          continue;
        }

        if (!current) {
          prelude.push(block);
          continue;
        }
        current.blocks.push(block);
      }

      if (prelude.length) {
        drafts.unshift({ title: 'Introduction', blocks: prelude });
      }
      if (current) drafts.push(current);
      return drafts;
    }
  }

  // Fallback: chunk by N blocks
  const drafts: ChapterDraft[] = [];
  for (let i = 0; i < blocks.length; i += fallbackBlocksPerChapter) {
    drafts.push({
      title: `Part ${drafts.length + 1}`,
      blocks: blocks.slice(i, i + fallbackBlocksPerChapter),
    });
  }
  return drafts;
}

function chapterText(
  draft: ChapterDraft,
  maxBlockLength?: number,
): string {
  const joined = draft.blocks
    .map((b) => b.plainText)
    .filter((t) => t && t.trim())
    .join('\n\n');
  if (!joined) return '';
  return normalizeTextForTts(joined, { maxBlockLength });
}

function preparedChapters(options: HtmlAudiobookAdapterOptions): PreparedAudiobookChapter[] {
  const drafts = buildChapterDrafts(options);
  const out: PreparedAudiobookChapter[] = [];
  for (const draft of drafts) {
    const text = chapterText(draft, options.maxBlockLength);
    if (!text.trim()) continue;
    out.push({
      index: out.length,
      title: draft.title,
      text,
    });
  }
  return out;
}

export function createHtmlAudiobookSourceAdapter(options: HtmlAudiobookAdapterOptions): AudiobookSourceAdapter {
  return {
    noContentMessage: 'No text content found in document',
    noAudioGeneratedMessage: 'No audio was generated from the document content',
    prepareChapters: async () => preparedChapters(options),
    prepareChapter: async (chapterIndex: number) => {
      const chapters = preparedChapters(options);
      const chapter = chapters[chapterIndex];
      if (!chapter) {
        throw new Error('Invalid chapter index');
      }
      return chapter;
    },
  };
}
