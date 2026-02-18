import path from 'path';

export const DOCSTORE_DIR = path.join(process.cwd(), 'docstore');
export const DEFAULT_LIBRARY_DIR = path.join(DOCSTORE_DIR, 'library');

export function parseLibraryRoots(): string[] {
  const raw = process.env.IMPORT_LIBRARY_DIRS ?? process.env.IMPORT_LIBRARY_DIR ?? '';

  const roots = raw
    .split(/[,:;]/g)
    .map((value) => value.trim())
    .filter(Boolean);

  if (roots.length > 0) {
    return roots;
  }

  return [DEFAULT_LIBRARY_DIR];
}

export function contentTypeForName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.epub') return 'application/epub+zip';
  if (ext === '.md' || ext === '.mdown' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export function decodeLibraryId(id: string): { rootIndex: number; relativePath: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex <= 0) return null;
    const rootIndex = Number(decoded.slice(0, sepIndex));
    if (!Number.isInteger(rootIndex) || rootIndex < 0) return null;
    const relativePath = decoded.slice(sepIndex + 1);
    if (!relativePath) return null;
    return { rootIndex, relativePath };
  } catch {
    return null;
  }
}

export function isPathWithinRoot(resolvedRoot: string, resolvedFile: string): boolean {
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

