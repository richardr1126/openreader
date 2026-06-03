import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AUDIOBOOKS_V1_DIR,
  DOCSTORE_DIR,
  DOCUMENTS_V1_DIR,
} from '@/lib/server/storage/docstore-legacy';

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

function applyNamespacePath(baseDir: string, namespace: string | null): string {
  if (!namespace) return baseDir;
  const safeNamespace = namespace.trim();
  if (!SAFE_NAMESPACE_REGEX.test(safeNamespace)) return baseDir;
  const resolved = path.resolve(baseDir, safeNamespace);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return baseDir;
  return resolved;
}

function extractIdFromFileName(fileName: string): string | null {
  const match = /^([a-f0-9]{64})__/i.exec(fileName);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return DOCUMENT_ID_REGEX.test(id) ? id : null;
}

function isLegacyDocumentMetadata(value: unknown): value is {
  id: string;
  type: string;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.type === 'string';
}

async function collectLegacyDocumentPaths(input: {
  documentIds: Set<string>;
  namespace: string | null;
}): Promise<Set<string>> {
  const matches = new Set<string>();
  if (input.documentIds.size === 0) return matches;

  const docsDir = applyNamespacePath(DOCUMENTS_V1_DIR, input.namespace);
  const docstoreDir = applyNamespacePath(DOCSTORE_DIR, input.namespace);

  if (fs.existsSync(docsDir)) {
    const entries = await fsp.readdir(docsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(docsDir, entry.name);
      let id = extractIdFromFileName(entry.name);
      if (!id) {
        const bytes = await fsp.readFile(fullPath).catch(() => null);
        if (!bytes) continue;
        id = createHash('sha256').update(bytes).digest('hex');
      }
      if (id && input.documentIds.has(id)) {
        matches.add(fullPath);
      }
    }
  }

  if (fs.existsSync(docstoreDir)) {
    const entries = await fsp.readdir(docstoreDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const metadataPath = path.join(docstoreDir, entry.name);
      const parsed = await fsp.readFile(metadataPath, 'utf8')
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => null);
      if (!isLegacyDocumentMetadata(parsed)) continue;

      const contentPath = path.join(docstoreDir, `${parsed.id}.${parsed.type}`);
      const bytes = await fsp.readFile(contentPath).catch(() => null);
      if (!bytes) continue;

      const id = createHash('sha256').update(bytes).digest('hex');
      if (!input.documentIds.has(id)) continue;

      matches.add(metadataPath);
      matches.add(contentPath);
    }
  }

  return matches;
}

async function collectLegacyAudiobookDirs(input: {
  audiobookIds: Set<string>;
  namespace: string | null;
}): Promise<Set<string>> {
  const matches = new Set<string>();
  if (input.audiobookIds.size === 0) return matches;

  const roots = [
    applyNamespacePath(AUDIOBOOKS_V1_DIR, input.namespace),
    applyNamespacePath(DOCSTORE_DIR, input.namespace),
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('-audiobook')) continue;
      const bookId = entry.name.slice(0, -'-audiobook'.length);
      if (input.audiobookIds.has(bookId)) {
        matches.add(path.join(root, entry.name));
      }
    }
  }

  return matches;
}

export async function cleanupClaimedLegacyFsSources(input: {
  documentIds: string[];
  audiobookIds: string[];
  namespace?: string | null;
}): Promise<{ deletedDocumentPaths: number; deletedAudiobookDirs: number }> {
  const documentIds = new Set(input.documentIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const audiobookIds = new Set(input.audiobookIds.map((id) => id.trim()).filter(Boolean));
  const namespace = input.namespace ?? null;

  const [documentPaths, audiobookDirs] = await Promise.all([
    collectLegacyDocumentPaths({ documentIds, namespace }),
    collectLegacyAudiobookDirs({ audiobookIds, namespace }),
  ]);

  let deletedDocumentPaths = 0;
  for (const filePath of documentPaths) {
    const removed = await fsp.unlink(filePath).then(() => true).catch(() => false);
    if (removed) deletedDocumentPaths += 1;
  }

  let deletedAudiobookDirs = 0;
  for (const dirPath of audiobookDirs) {
    const existed = fs.existsSync(dirPath);
    await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    if (existed && !fs.existsSync(dirPath)) deletedAudiobookDirs += 1;
  }

  return {
    deletedDocumentPaths,
    deletedAudiobookDirs,
  };
}
