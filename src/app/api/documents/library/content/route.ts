import { readFile, stat } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { contentTypeForName, decodeLibraryId, isPathWithinRoot, parseLibraryRoots } from '@/lib/server/storage/library-mount';
import { auth } from '@/lib/server/auth/auth';

export const dynamic = 'force-dynamic';

const HEADER_CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;

function stripHeaderControlChars(value: string): string {
  return value.replace(HEADER_CONTROL_CHARS_REGEX, '');
}

function toAsciiFilenameFallback(filename: string): string {
  const stripped = stripHeaderControlChars(filename);
  const withoutQuotes = stripped.replace(/["\\]/g, '');
  const asciiOnly = withoutQuotes.replace(/[^\x20-\x7E]/g, '_').replace(/[\/\\]/g, '_').trim();
  return asciiOnly || 'download';
}

function encodeRFC5987ValueChars(value: string): string {
  const stripped = stripHeaderControlChars(value);
  const bytes = new TextEncoder().encode(stripped);
  let out = '';

  for (const byte of bytes) {
    const isAlphaNumeric =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a);

    const isAttrChar =
      isAlphaNumeric ||
      byte === 0x21 ||
      byte === 0x23 ||
      byte === 0x24 ||
      byte === 0x26 ||
      byte === 0x2b ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5e ||
      byte === 0x5f ||
      byte === 0x60 ||
      byte === 0x7c ||
      byte === 0x7e;

    out += isAttrChar ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  return out || 'download';
}

function contentDispositionAttachment(filename: string): string {
  const fallback = toAsciiFilenameFallback(filename);
  const encoded = encodeRFC5987ValueChars(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: NextRequest) {
  // Auth check - require session
  const session = await auth?.api.getSession({ headers: req.headers });
  if (auth && !session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const decoded = decodeLibraryId(id);
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const roots = parseLibraryRoots();
  const root = roots[decoded.rootIndex];
  if (!root) {
    return NextResponse.json({ error: 'Invalid library root' }, { status: 400 });
  }

  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, decoded.relativePath);
  if (!isPathWithinRoot(resolvedRoot, resolvedFile)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(resolvedFile);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!fileStat.isFile()) {
    return NextResponse.json({ error: 'Not a file' }, { status: 400 });
  }

  const content = await readFile(resolvedFile);
  const fileName = path.basename(decoded.relativePath);

  return new NextResponse(content, {
    headers: {
      'Content-Type': contentTypeForName(fileName),
      'Content-Disposition': contentDispositionAttachment(fileName),
      'Cache-Control': 'no-store',
    },
  });
}
