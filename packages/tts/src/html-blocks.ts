/**
 * Block-level parser for markdown and plain-text documents used by the HTML
 * reader. The reader assigns one stable anchor per top-level block so each
 * block can become a TTS segment locator (`{ readerType: 'html', location }`)
 * and so sentence/word highlights have a scoped DOM root.
 *
 * The parser is intentionally hand-rolled and line-based: we don't need a full
 * mdast tree, just block boundaries plus a TTS-clean `plainText`. ReactMarkdown
 * still renders the raw markdown for each block, so inline formatting
 * (bold/italic/links/code) round-trips visually.
 */

export type HtmlBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'hr';

export interface HtmlBlock {
  index: number;
  anchorId: string;
  kind: HtmlBlockKind;
  raw: string;
  plainText: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  headingText?: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const SETEXT_H1_RE = /^=+\s*$/;
const SETEXT_H2_RE = /^-{2,}\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/;
const BLOCKQUOTE_RE = /^\s{0,3}>/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

export function anchorIdForIndex(index: number): string {
  return `b-${index.toString().padStart(4, '0')}`;
}

export function splitMarkdownBlocks(source: string): HtmlBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: HtmlBlock[] = [];
  let i = 0;

  const pushBlock = (
    kind: HtmlBlockKind,
    rawLines: string[],
    extra: Partial<Pick<HtmlBlock, 'headingLevel' | 'headingText'>> = {},
  ) => {
    const raw = rawLines.join('\n').replace(/\s+$/u, '');
    if (!raw) return;
    const plainText = mdToPlainText(raw, kind);
    const index = blocks.length;
    blocks.push({
      index,
      anchorId: anchorIdForIndex(index),
      kind,
      raw,
      plainText,
      ...extra,
    });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const start = i;
      i += 1;
      while (i < lines.length) {
        const ll = lines[i];
        const closing = FENCE_RE.exec(ll);
        i += 1;
        if (closing && closing[2].startsWith(marker[0]) && closing[2].length >= marker.length && !closing[3].trim()) {
          break;
        }
      }
      pushBlock('code', lines.slice(start, i));
      continue;
    }

    if (HR_RE.test(line)) {
      pushBlock('hr', [line]);
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      pushBlock('heading', [line], { headingLevel: level, headingText: text });
      i += 1;
      continue;
    }

    // Setext heading: previous-line text + underline of = or -
    if (i + 1 < lines.length && lines[i].trim() && (SETEXT_H1_RE.test(lines[i + 1]) || SETEXT_H2_RE.test(lines[i + 1]))) {
      const level: 1 | 2 = SETEXT_H1_RE.test(lines[i + 1]) ? 1 : 2;
      const text = lines[i].trim();
      pushBlock('heading', [lines[i], lines[i + 1]], { headingLevel: level, headingText: text });
      i += 2;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const start = i;
      while (i < lines.length && (BLOCKQUOTE_RE.test(lines[i]) || (lines[i].trim() && !HEADING_RE.test(lines[i]) && !HR_RE.test(lines[i])))) {
        i += 1;
      }
      pushBlock('blockquote', lines.slice(start, i));
      continue;
    }

    if (LIST_RE.test(line)) {
      const start = i;
      while (i < lines.length) {
        const ll = lines[i];
        if (!ll.trim()) {
          // peek: if next line continues the list, include the blank line; otherwise stop
          if (i + 1 < lines.length && (LIST_RE.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) {
            i += 1;
            continue;
          }
          break;
        }
        if (LIST_RE.test(ll) || /^\s+\S/.test(ll)) {
          i += 1;
          continue;
        }
        break;
      }
      pushBlock('list', lines.slice(start, i));
      continue;
    }

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const start = i;
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        i += 1;
      }
      pushBlock('table', lines.slice(start, i));
      continue;
    }

    // Paragraph: consume until blank line or a new block-level construct
    const start = i;
    while (i < lines.length) {
      const ll = lines[i];
      if (!ll.trim()) break;
      if (HEADING_RE.test(ll) || HR_RE.test(ll) || FENCE_RE.test(ll) || BLOCKQUOTE_RE.test(ll) || LIST_RE.test(ll)) break;
      if (i + 1 < lines.length && (SETEXT_H1_RE.test(lines[i + 1]) || SETEXT_H2_RE.test(lines[i + 1])) && i > start) break;
      i += 1;
    }
    pushBlock('paragraph', lines.slice(start, i));
  }

  return blocks;
}

export function splitTxtBlocks(source: string): HtmlBlock[] {
  const normalized = source.replace(/\r\n?/g, '\n');
  const rawBlocks = normalized.split(/\n{2,}/);
  const blocks: HtmlBlock[] = [];
  for (const raw of rawBlocks) {
    const trimmed = raw.replace(/\s+$/u, '');
    if (!trimmed.trim()) continue;
    const index = blocks.length;
    blocks.push({
      index,
      anchorId: anchorIdForIndex(index),
      kind: 'paragraph',
      raw: trimmed,
      plainText: trimmed.replace(/\s+/g, ' ').trim(),
    });
  }
  return blocks;
}

export function parseHtmlBlocks(source: string, isTxt: boolean): HtmlBlock[] {
  return isTxt ? splitTxtBlocks(source) : splitMarkdownBlocks(source);
}

/**
 * Strip markdown formatting from a block to produce text suitable for TTS.
 *
 * This is intentionally conservative — we keep semantic words but remove
 * structural noise (heading hashes, list bullets, fence markers, link URLs).
 */
export function mdToPlainText(raw: string, kind: HtmlBlockKind): string {
  if (kind === 'hr') return '';

  let text = raw;

  if (kind === 'code') {
    text = text
      .split('\n')
      .filter((line) => !FENCE_RE.test(line))
      .join('\n');
  }

  if (kind === 'heading') {
    text = text.replace(HEADING_RE, '$2').replace(/\s+#+\s*$/, '');
    // setext form: drop the underline line
    text = text
      .split('\n')
      .filter((line) => !SETEXT_H1_RE.test(line) && !SETEXT_H2_RE.test(line))
      .join('\n')
      .trim();
  }

  if (kind === 'blockquote') {
    text = text
      .split('\n')
      .map((line) => line.replace(/^\s{0,3}>\s?/, ''))
      .join(' ');
  }

  if (kind === 'list') {
    text = text
      .split('\n')
      .map((line) => line.replace(LIST_RE, '').replace(/^\s+/, ''))
      .join(' ');
  }

  if (kind === 'table') {
    text = text
      .split('\n')
      .filter((line) => !TABLE_SEP_RE.test(line))
      .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, '  '))
      .join(' ');
  }

  // Inline markdown stripping (run for every kind except code, where contents
  // are read verbatim).
  if (kind !== 'code') {
    text = stripInlineMarkdown(text);
  }

  return text.replace(/\s+/g, ' ').trim();
}

function stripInlineMarkdown(text: string): string {
  return text
    // Image-link wrappers: [![alt](badge.svg)](https://...) — common for
    // shields/license/CI badges. The visible DOM is just an `<a><img></a>`
    // with no text node, so keeping the alt text in `plainText` would cause
    // TTS to read words ("GitHub License", "build passing", …) that the
    // sentence-highlight pattern matcher can't find in the rendered DOM,
    // and the whole first-segment match falls below threshold. Drop them.
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    // Standalone images: ![alt](url) — same reasoning. The browser renders
    // an `<img>` with no text content; alt is only read by AT, not TTS.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Reference-style images: ![alt][ref] — drop for the same reason.
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // links: [label](url) → label (label IS rendered as visible link text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // reference-style links: [label][ref] → label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // bold/italic markers around words: **x**, *x*, __x__, _x_
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // inline code: `x` → x
    .replace(/`([^`]+)`/g, '$1')
    // strikethrough: ~~x~~ → x
    .replace(/~~(.+?)~~/g, '$1')
    // stray html tags (also strips inline <img> / <svg> / <picture>)
    .replace(/<[^>]+>/g, '');
}

/**
 * Concatenate every block's plain text into one TTS source string. The whole
 * HTML/TXT/MD document is treated as a single flat sequence of segments, so this
 * is the canonical full-document text shared by the client reader and the
 * worker-owned planner (single source of truth for identity parity).
 */
export function buildHtmlDocumentText(blocks: HtmlBlock[]): string {
  return blocks
    .map((b) => b.plainText)
    .filter((t) => t && t.trim())
    .join('\n\n');
}
