import path from 'node:path';
import { normalizeOptionalLanguageTag } from '@openreader/tts/language';
import type { DocumentType } from '@/types/documents';
import { detectTextLanguage } from '@/lib/server/documents/text-language';
import { ZipEntries } from '@/lib/server/documents/zip-entries';

/**
 * Bibliographic metadata captured when a document is imported. Everything
 * here is best-effort: a value that cannot be found cheaply stays null.
 */
export type ImportMetadata = {
  author: string | null;
  language: string | null;
};

export const AUTHOR_MAX_LENGTH = 300;
const MAX_AUTHORS = 3;
const EPUB_XML_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_SAMPLE_MAX_BYTES = 4 * 1024 * 1024;
const PDF_STRING_MAX_BYTES = 2_048;
const XMP_SCAN_BYTES = 64 * 1024;

/** Placeholder names office suites and PDF printers write into "Author". */
const PLACEHOLDER_AUTHORS = new Set([
  'user', 'admin', 'administrator', 'owner', 'author', 'unknown', 'anonymous',
  'microsoft office user', 'windows user', 'default',
]);

export function normalizeAuthor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const author = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!author || PLACEHOLDER_AUTHORS.has(author.toLowerCase())) return null;
  return author.slice(0, AUTHOR_MAX_LENGTH);
}

export function normalizeLanguage(value: unknown): string | null {
  const tag = normalizeOptionalLanguageTag(value);
  if (!tag || tag.toLowerCase() === 'und') return null;
  return tag;
}

function joinAuthors(names: string[]): string | null {
  const unique = [...new Set(names.map((name) => normalizeAuthor(name)).filter((name): name is string => !!name))];
  return unique.length > 0 ? normalizeAuthor(unique.slice(0, MAX_AUTHORS).join(', ')) : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(attributes);
  return match ? decodeXmlEntities(match[2] ?? match[3] ?? '') : null;
}

function xmlElements(xml: string, localName: string): Array<{ attributes: string; text: string }> {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${localName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${localName}\\s*>)`,
    'giu',
  );
  return [...xml.matchAll(pattern)].map((match) => ({
    attributes: match[1] ?? '',
    text: decodeXmlEntities(match[2] ?? '').trim(),
  }));
}

/** dc:creator entries that are authors (EPUB 2 `opf:role` or EPUB 3 `refines` role, or none). */
export function readOpfMetadata(opf: string): ImportMetadata {
  const roles = new Map<string, string>();
  for (const meta of xmlElements(opf, 'meta')) {
    const refines = attribute(meta.attributes, 'refines');
    if (refines?.startsWith('#') && attribute(meta.attributes, 'property') === 'role') {
      roles.set(refines.slice(1), meta.text.toLowerCase());
    }
  }
  const authors = xmlElements(opf, 'creator').filter((creator) => {
    const id = attribute(creator.attributes, 'id');
    const role = (attribute(creator.attributes, 'role') ?? (id ? roles.get(id) : null) ?? 'aut').toLowerCase();
    return role === 'aut' && creator.text;
  });
  const language = xmlElements(opf, 'language').map((element) => normalizeLanguage(element.text)).find(Boolean);
  return { author: joinAuthors(authors.map((creator) => creator.text)), language: language ?? null };
}

export function readEpubMetadata(bytes: Buffer): ImportMetadata {
  const zip = ZipEntries.open(bytes);
  const container = zip?.readText('META-INF/container.xml', EPUB_XML_MAX_BYTES);
  if (!zip || !container) return { author: null, language: null };
  const rootfile = xmlElements(container, 'rootfile')
    .map((element) => attribute(element.attributes, 'full-path'))
    .find((value): value is string => !!value);
  const opf = rootfile ? zip.readText(path.posix.normalize(rootfile), EPUB_XML_MAX_BYTES) : null;
  return opf ? readOpfMetadata(opf) : { author: null, language: null };
}

function decodePdfStringBytes(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.slice(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const high = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = high;
    }
    return swapped.toString('utf16le', 0, swapped.length - (swapped.length % 2));
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return Buffer.from(bytes.slice(3)).toString('utf8');
  }
  return Buffer.from(bytes).toString('latin1');
}

/** Reads the PDF string object (literal or hex) that starts at `offset`. */
export function readPdfString(bytes: Buffer, offset: number): string | null {
  let cursor = offset;
  while (cursor < bytes.length && /\s/u.test(String.fromCharCode(bytes[cursor]))) cursor += 1;
  const out: number[] = [];
  if (bytes[cursor] === 0x3c /* < */ && bytes[cursor + 1] !== 0x3c) {
    const end = bytes.indexOf(0x3e /* > */, cursor);
    if (end < 0 || end - cursor > PDF_STRING_MAX_BYTES * 2) return null;
    const hex = bytes.toString('latin1', cursor + 1, end).replace(/[^0-9a-f]/giu, '');
    for (let index = 0; index < hex.length; index += 2) {
      out.push(Number.parseInt(hex.slice(index, index + 2).padEnd(2, '0'), 16));
    }
    return decodePdfStringBytes(out);
  }
  if (bytes[cursor] !== 0x28 /* ( */) return null;
  let depth = 1;
  cursor += 1;
  const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
  while (cursor < bytes.length && out.length < PDF_STRING_MAX_BYTES) {
    const byte = bytes[cursor];
    if (byte === 0x5c /* \ */) {
      const next = bytes[cursor + 1];
      const char = String.fromCharCode(next);
      if (char in escapes) {
        out.push(escapes[char]);
        cursor += 2;
      } else if (next >= 0x30 && next <= 0x37) {
        let octal = '';
        let index = cursor + 1;
        while (octal.length < 3 && bytes[index] >= 0x30 && bytes[index] <= 0x37) {
          octal += String.fromCharCode(bytes[index]);
          index += 1;
        }
        out.push(Number.parseInt(octal, 8) & 0xff);
        cursor = index;
      } else if (next === 0x0d || next === 0x0a) {
        cursor += next === 0x0d && bytes[cursor + 2] === 0x0a ? 3 : 2;
      } else {
        out.push(next);
        cursor += 2;
      }
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) return decodePdfStringBytes(out);
    }
    out.push(byte);
    cursor += 1;
  }
  return null;
}

function pdfKeyValues(bytes: Buffer, key: string): string[] {
  const values: string[] = [];
  const needle = Buffer.from(key, 'latin1');
  let offset = bytes.indexOf(needle);
  while (offset >= 0 && values.length < 4) {
    const after = offset + needle.length;
    // `/Author` must not match `/AuthorX`.
    if (!/[A-Za-z0-9]/u.test(String.fromCharCode(bytes[after] ?? 0x20))) {
      const value = readPdfString(bytes, after);
      if (value) values.push(value);
    }
    offset = bytes.indexOf(needle, after);
  }
  return values;
}

function readXmpField(bytes: Buffer, field: 'creator' | 'language'): string[] {
  const start = bytes.indexOf(Buffer.from(`<dc:${field}`, 'latin1'));
  if (start < 0) return [];
  const xml = bytes.toString('utf8', start, Math.min(bytes.length, start + XMP_SCAN_BYTES));
  const end = xml.indexOf(`</dc:${field}`);
  if (end < 0) return [];
  const inner = xml.slice(xml.indexOf('>') + 1, end);
  const items = xmlElements(inner, 'li').map((item) => item.text);
  return (items.length > 0 ? items : [decodeXmlEntities(inner).trim()]).filter(Boolean);
}

/**
 * Author and language from an uncompressed document information dictionary,
 * catalog `/Lang`, or XMP packet. Values inside compressed object streams are
 * not decoded; those PDFs simply stay without metadata.
 */
export function readPdfMetadata(bytes: Buffer): ImportMetadata {
  const author = joinAuthors(pdfKeyValues(bytes, '/Author').slice(0, 1))
    ?? joinAuthors(readXmpField(bytes, 'creator'));
  const language = [...pdfKeyValues(bytes, '/Lang'), ...readXmpField(bytes, 'language')]
    .map(normalizeLanguage)
    .find(Boolean) ?? null;
  return { author, language };
}

function readTextLanguage(bytes: Buffer, name: string): string | null {
  const text = bytes.toString('utf8', 0, Math.min(bytes.length, TEXT_SAMPLE_MAX_BYTES));
  const isHtml = /\.x?html?$/iu.test(name) || /^\s*(?:<!doctype html|<html)/iu.test(text);
  if (!isHtml) return detectTextLanguage(text);
  const htmlTag = /<html\b([^>]*)>/iu.exec(text);
  const declared = htmlTag ? normalizeLanguage(attribute(htmlTag[1] ?? '', 'lang')) : null;
  if (declared) return declared;
  const body = text
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
  return detectTextLanguage(decodeXmlEntities(body));
}

/**
 * Metadata for a newly imported document. Explicit hints (a catalog entry or a
 * web article byline) win over embedded metadata, which wins over detection.
 * Never throws: an unreadable file just yields nulls.
 */
export function extractImportMetadata(input: {
  type: DocumentType;
  name: string;
  body: Buffer | null;
  hints?: Partial<ImportMetadata>;
}): ImportMetadata {
  const hinted: ImportMetadata = {
    author: normalizeAuthor(input.hints?.author),
    language: normalizeLanguage(input.hints?.language),
  };
  if (hinted.author && hinted.language) return hinted;

  let embedded: ImportMetadata = { author: null, language: null };
  try {
    if (input.body) {
      if (input.type === 'epub') embedded = readEpubMetadata(input.body);
      else if (input.type === 'pdf') embedded = readPdfMetadata(input.body);
      else if (input.type === 'html' && !hinted.language) {
        embedded = { author: null, language: readTextLanguage(input.body, input.name) };
      }
    }
  } catch {
    embedded = { author: null, language: null };
  }

  return {
    author: hinted.author ?? embedded.author,
    language: hinted.language ?? embedded.language,
  };
}
