import type { PDFDocumentProxy } from 'pdfjs-dist';

import type { AudiobookSourceAdapter, PreparedAudiobookChapter } from '@/lib/client/audiobooks/pipeline';
import { normalizeTextForTts } from '@/lib/shared/nlp';
import type { ParsedPdfDocument, ParsedPdfBlock } from '@/types/parsed-pdf';
import type { DocumentSettings } from '@/types/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';

interface PdfAudiobookAdapterOptions {
  pdfDocument?: PDFDocumentProxy;
  parsed?: ParsedPdfDocument;
  settings?: DocumentSettings;
  margins: {
    header: number;
    footer: number;
    left: number;
    right: number;
  };
  smartSentenceSplitting: boolean;
  maxBlockLength?: number;
}

function chapterTextFromBlocks(
  blocks: ParsedPdfBlock[],
  smartSentenceSplitting: boolean,
  maxBlockLength?: number,
): string {
  const text = blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) return '';
  return smartSentenceSplitting ? normalizeTextForTts(text, { maxBlockLength }) : text;
}

function prepareParsedChapters({
  parsed,
  settings,
  smartSentenceSplitting,
  maxBlockLength,
}: {
  parsed: ParsedPdfDocument;
  settings: DocumentSettings;
  smartSentenceSplitting: boolean;
  maxBlockLength?: number;
}): PreparedAudiobookChapter[] {
  const skip = new Set(settings.pdf?.skipBlockKinds ?? DEFAULT_DOCUMENT_SETTINGS.pdf?.skipBlockKinds ?? []);
  const allBlocks = parsed.pages
    .flatMap((page) => page.blocks)
    .filter((block) => !skip.has(block.kind));
  if (!allBlocks.length) return [];

  const chaptersFromSections = settings.pdf?.chaptersFromSections ?? true;
  if (!chaptersFromSections) {
    const text = chapterTextFromBlocks(allBlocks, smartSentenceSplitting, maxBlockLength);
    return text ? [{ index: 0, title: 'Document', text }] : [];
  }

  const chapters: PreparedAudiobookChapter[] = [];
  let currentTitle = 'Introduction';
  let currentBlocks: ParsedPdfBlock[] = [];

  const flush = () => {
    if (!currentBlocks.length) return;
    const text = chapterTextFromBlocks(currentBlocks, smartSentenceSplitting, maxBlockLength);
    if (text) {
      chapters.push({
        index: chapters.length,
        title: currentTitle,
        text,
      });
    }
    currentBlocks = [];
  };

  for (const block of allBlocks) {
    if (block.kind === 'section-header') {
      flush();
      currentTitle = block.text.trim() || `Chapter ${chapters.length + 1}`;
      currentBlocks.push(block);
      continue;
    }
    currentBlocks.push(block);
  }
  flush();

  return chapters;
}

async function extractPreparedPdfChapters({
  pdfDocument,
  parsed,
  settings = DEFAULT_DOCUMENT_SETTINGS,
  margins,
  smartSentenceSplitting,
  maxBlockLength,
}: PdfAudiobookAdapterOptions): Promise<PreparedAudiobookChapter[]> {
  if (parsed) {
    const parsedChapters = prepareParsedChapters({
      parsed,
      settings,
      smartSentenceSplitting,
      maxBlockLength,
    });
    if (parsedChapters.length > 0) {
      return parsedChapters;
    }
  }

  if (!pdfDocument) {
    throw new Error('No PDF document loaded');
  }

  const { extractTextFromPDF } = await import('@/lib/client/pdf');

  const chapters: PreparedAudiobookChapter[] = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const rawText = await extractTextFromPDF(pdfDocument, pageNum, margins);
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      continue;
    }

    chapters.push({
      index: chapters.length,
      title: `Page ${chapters.length + 1}`,
      text: smartSentenceSplitting ? normalizeTextForTts(trimmedText, { maxBlockLength }) : trimmedText,
    });
  }

  return chapters;
}

export function createPdfAudiobookSourceAdapter(options: PdfAudiobookAdapterOptions): AudiobookSourceAdapter {
  return {
    noContentMessage: 'No text content found in PDF',
    noAudioGeneratedMessage: 'No audio was generated from the PDF content',
    prepareChapters: async () => extractPreparedPdfChapters(options),
    prepareChapter: async (chapterIndex: number) => {
      const chapters = await extractPreparedPdfChapters(options);
      const chapter = chapters[chapterIndex];
      if (!chapter) {
        throw new Error('Invalid chapter index');
      }
      return chapter;
    },
  };
}
