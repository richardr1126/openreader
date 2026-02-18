import type { Dirent } from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { parseLibraryRoots } from '@/lib/server/storage/library-mount';
import type { DocumentType } from '@/types/documents';
import { auth } from '@/lib/server/auth/auth';

export const dynamic = 'force-dynamic';

type LibraryDocument = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  type: DocumentType;
};

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.epub',
  '.html',
  '.htm',
  '.txt',
  '.md',
  '.mdown',
  '.markdown',
]);

const IGNORE_DIR_NAMES = new Set(['.git', 'node_modules', 'model', 'tmp', 'documents', 'documents_v1', 'audiobooks_v1']);

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function libraryDocumentTypeFromName(name: string): DocumentType {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  return 'html';
}

let cache:
  | {
    cacheKey: string;
    cachedAt: number;
    documents: LibraryDocument[];
  }
  | undefined;

async function scanLibraryRoot(root: string, rootIndex: number, limit: number): Promise<LibraryDocument[]> {
  const results: LibraryDocument[] = [];
  const resolvedRoot = path.resolve(root);

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= limit) return;

    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (IGNORE_DIR_NAMES.has(entry.name)) continue;
        if (entry.name.endsWith('-audiobook')) continue;
        await walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const fullPath = path.join(currentDir, entry.name);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }

      const relativePath = toPosixPath(path.relative(resolvedRoot, fullPath));
      const id = Buffer.from(`${rootIndex}:${relativePath}`, 'utf8').toString('base64url');

      results.push({
        id,
        name: relativePath,
        size: fileStat.size,
        lastModified: Math.floor(fileStat.mtimeMs),
        type: libraryDocumentTypeFromName(relativePath),
      });
    }
  }

  await walk(resolvedRoot);
  return results;
}

export async function GET(req: NextRequest) {
  // Auth check - require session
  const session = await auth?.api.getSession({ headers: req.headers });
  if (auth && !session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const refresh = url.searchParams.get('refresh') === '1';
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? '5000'), 10000));

  const roots = parseLibraryRoots();
  const cacheKey = `${roots.join('|')}::${limit}`;

  if (!refresh && cache && cache.cacheKey === cacheKey && Date.now() - cache.cachedAt < 30_000) {
    return NextResponse.json({ documents: cache.documents });
  }

  const documents: LibraryDocument[] = [];
  for (let i = 0; i < roots.length; i++) {
    const rootDocs = await scanLibraryRoot(roots[i], i, Math.max(0, limit - documents.length));
    documents.push(...rootDocs);
    if (documents.length >= limit) break;
  }

  documents.sort((a, b) => a.name.localeCompare(b.name));

  cache = { cacheKey, cachedAt: Date.now(), documents };
  return NextResponse.json({ documents });
}
