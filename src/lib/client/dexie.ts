import Dexie, { type EntityTable } from 'dexie';
import { APP_CONFIG_DEFAULTS, type ViewType, type SavedVoices, type AppConfigRow } from '@/types/config';
import {
  PDFDocument,
  EPUBDocument,
  HTMLDocument,
  DocumentListState,
  BaseDocument,
  DocumentListDocument,
} from '@/types/documents';
import { sha256HexFromBytes, sha256HexFromString } from '@/lib/client/sha256';
import { downloadDocumentContent, listDocuments, uploadDocumentSources, type UploadSource } from '@/lib/client/api/documents';
import { cacheStoredDocumentFromBytes } from '@/lib/client/cache/documents';

const DB_NAME = 'openreader-db';
// Managed via Dexie (version bumped from the original manual IndexedDB)
const DB_VERSION = 8;

const PDF_TABLE = 'pdf-documents' as const;
const EPUB_TABLE = 'epub-documents' as const;
const HTML_TABLE = 'html-documents' as const;
const CONFIG_TABLE = 'config' as const;
const APP_CONFIG_TABLE = 'app-config' as const;
const LAST_LOCATION_TABLE = 'last-locations' as const;
const DOCUMENT_ID_MAP_TABLE = 'document-id-map' as const;
const PREVIEW_CACHE_TABLE = 'document-preview-cache' as const;
const MIB = 1024 * 1024;
const DOCUMENT_CACHE_MAX_BYTES = 1024 * MIB; // 1 GiB
const PREVIEW_CACHE_MAX_BYTES = 128 * MIB; // 128 MiB

interface DocumentCacheMeta {
  cacheCreatedAt?: number;
  cacheAccessedAt?: number;
  cacheByteSize?: number;
}

type PDFCacheRow = PDFDocument & DocumentCacheMeta;
type EPUBCacheRow = EPUBDocument & DocumentCacheMeta;
type HTMLCacheRow = HTMLDocument & DocumentCacheMeta;

export interface LastLocationRow {
  docId: string;
  location: string;
}

export interface DocumentIdMapRow {
  oldId: string;
  id: string;
  createdAt: number;
}

export interface DocumentPreviewCacheRow {
  docId: string;
  lastModified: number;
  contentType: string;
  data: ArrayBuffer;
  cachedAt: number;
  byteSize?: number;
}

export interface ConfigRow {
  key: string;
  value: string;
}

type OpenReaderDB = Dexie & {
  [PDF_TABLE]: EntityTable<PDFCacheRow, 'id'>;
  [EPUB_TABLE]: EntityTable<EPUBCacheRow, 'id'>;
  [HTML_TABLE]: EntityTable<HTMLCacheRow, 'id'>;
  [CONFIG_TABLE]: EntityTable<ConfigRow, 'key'>;
  [APP_CONFIG_TABLE]: EntityTable<AppConfigRow, 'id'>;
  [LAST_LOCATION_TABLE]: EntityTable<LastLocationRow, 'docId'>;
  [DOCUMENT_ID_MAP_TABLE]: EntityTable<DocumentIdMapRow, 'oldId'>;
  [PREVIEW_CACHE_TABLE]: EntityTable<DocumentPreviewCacheRow, 'docId'>;
};

export const db = new Dexie(DB_NAME) as OpenReaderDB;



type DexieOpenStatus = 'opening' | 'opened' | 'blocked' | 'stalled' | 'error';

function emitDexieStatus(status: DexieOpenStatus, detail?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('openreader:dexie', {
        detail: { status, ...detail },
      }),
    );
  } catch {
    // ignore
  }
}

if (typeof window !== 'undefined') {
  // Fired when this tab's open/upgrade is blocked by another tab holding the DB open.
  db.on('blocked', () => {
    emitDexieStatus('blocked');
  });
}

const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  'custom-openai': '',
};

type RawConfigMap = Record<string, string | undefined>;

function inferProviderAndBaseUrl(raw: RawConfigMap): { provider: string; baseUrl: string } {
  const cachedApiKey = raw.apiKey;
  const cachedBaseUrl = raw.baseUrl;
  let inferredProvider = raw.ttsProvider || '';

  if (!raw.ttsProvider) {
    inferredProvider = process.env.NEXT_PUBLIC_DEFAULT_TTS_PROVIDER || 'custom-openai';
  } else if (!inferredProvider) {
    if (cachedBaseUrl) {
      const baseUrlLower = cachedBaseUrl.toLowerCase();
      if (baseUrlLower.includes('deepinfra.com')) {
        inferredProvider = 'deepinfra';
      } else if (baseUrlLower.includes('openai.com')) {
        inferredProvider = 'openai';
      } else if (
        baseUrlLower.includes('localhost') ||
        baseUrlLower.includes('127.0.0.1') ||
        baseUrlLower.includes('internal')
      ) {
        inferredProvider = 'custom-openai';
      } else {
        inferredProvider = cachedApiKey ? 'openai' : 'custom-openai';
      }
    } else {
      inferredProvider = cachedApiKey ? 'openai' : 'custom-openai';
    }
  }

  let baseUrl = cachedBaseUrl || '';
  if (!baseUrl) {
    if (inferredProvider === 'openai') {
      baseUrl = PROVIDER_DEFAULT_BASE_URL.openai;
    } else if (inferredProvider === 'deepinfra') {
      baseUrl = PROVIDER_DEFAULT_BASE_URL.deepinfra;
    } else {
      baseUrl = PROVIDER_DEFAULT_BASE_URL['custom-openai'];
    }
  }

  return { provider: inferredProvider, baseUrl };
}

function buildAppConfigFromRaw(raw: RawConfigMap): AppConfigRow {
  const { provider, baseUrl } = inferProviderAndBaseUrl(raw);

  let savedVoices: SavedVoices = {};
  if (raw.savedVoices) {
    try {
      savedVoices = JSON.parse(raw.savedVoices) as SavedVoices;
    } catch (error) {
      console.error('Error parsing savedVoices during migration:', error);
    }
  }

  let documentListState: DocumentListState = APP_CONFIG_DEFAULTS.documentListState;
  if (raw.documentListState) {
    try {
      documentListState = JSON.parse(raw.documentListState) as DocumentListState;
    } catch (error) {
      console.error('Error parsing documentListState during migration:', error);
    }
  }

  const config: AppConfigRow = {
    id: 'singleton',
    ...APP_CONFIG_DEFAULTS,
    apiKey: raw.apiKey ?? APP_CONFIG_DEFAULTS.apiKey,
    baseUrl,
    viewType: (raw.viewType as ViewType) || APP_CONFIG_DEFAULTS.viewType,
    voiceSpeed: raw.voiceSpeed ? parseFloat(raw.voiceSpeed) : APP_CONFIG_DEFAULTS.voiceSpeed,
    audioPlayerSpeed: raw.audioPlayerSpeed ? parseFloat(raw.audioPlayerSpeed) : APP_CONFIG_DEFAULTS.audioPlayerSpeed,
    voice: '',
    skipBlank: raw.skipBlank === 'false' ? false : APP_CONFIG_DEFAULTS.skipBlank,
    epubTheme: raw.epubTheme === 'true',
    smartSentenceSplitting:
      raw.smartSentenceSplitting === 'false' ? false : APP_CONFIG_DEFAULTS.smartSentenceSplitting,
    headerMargin: raw.headerMargin ? parseFloat(raw.headerMargin) : APP_CONFIG_DEFAULTS.headerMargin,
    footerMargin: raw.footerMargin ? parseFloat(raw.footerMargin) : APP_CONFIG_DEFAULTS.footerMargin,
    leftMargin: raw.leftMargin ? parseFloat(raw.leftMargin) : APP_CONFIG_DEFAULTS.leftMargin,
    rightMargin: raw.rightMargin ? parseFloat(raw.rightMargin) : APP_CONFIG_DEFAULTS.rightMargin,
    ttsProvider: provider || APP_CONFIG_DEFAULTS.ttsProvider,
    ttsModel:
      raw.ttsModel ||
      (provider === 'openai'
        ? 'tts-1'
        : provider === 'deepinfra'
          ? 'hexgrad/Kokoro-82M'
          : APP_CONFIG_DEFAULTS.ttsModel),
    ttsInstructions: raw.ttsInstructions ?? APP_CONFIG_DEFAULTS.ttsInstructions,
    savedVoices,
    pdfHighlightEnabled:
      raw.pdfHighlightEnabled === 'false' ? false : APP_CONFIG_DEFAULTS.pdfHighlightEnabled,
    pdfWordHighlightEnabled:
      raw.pdfWordHighlightEnabled === 'false' ? false : APP_CONFIG_DEFAULTS.pdfWordHighlightEnabled,
    epubHighlightEnabled:
      raw.epubHighlightEnabled === 'false' ? false : APP_CONFIG_DEFAULTS.epubHighlightEnabled,
    epubWordHighlightEnabled:
      raw.epubWordHighlightEnabled === 'false' ? false : APP_CONFIG_DEFAULTS.epubWordHighlightEnabled,
    firstVisit: raw.firstVisit === 'true',
    documentListState,
  };

  const voiceKey = `${config.ttsProvider}:${config.ttsModel}`;
  config.voice = config.savedVoices[voiceKey] || '';

  return config;
}

// Version 8: add local cache metadata/indexes so document + preview caches can be bounded via LRU pruning.
db.version(DB_VERSION).stores({
  [PDF_TABLE]: 'id, type, name, lastModified, size, folderId, cacheAccessedAt',
  [EPUB_TABLE]: 'id, type, name, lastModified, size, folderId, cacheAccessedAt',
  [HTML_TABLE]: 'id, type, name, lastModified, size, folderId, cacheAccessedAt',
  [APP_CONFIG_TABLE]: 'id',
  [LAST_LOCATION_TABLE]: 'docId',
  [DOCUMENT_ID_MAP_TABLE]: 'oldId, id, createdAt',
  [PREVIEW_CACHE_TABLE]: 'docId, lastModified, cachedAt, byteSize',
  // `null` here means: drop the old 'config' table after upgrade runs,
  // but Dexie still lets us read it inside the upgrade transaction.
  [CONFIG_TABLE]: null,
}).upgrade(async (trans) => {
  const appConfig = await trans.table<AppConfigRow, string>(APP_CONFIG_TABLE).get('singleton');
  if (appConfig) {
    return;
  }

  const configRows = await trans.table<ConfigRow, string>(CONFIG_TABLE).toArray();
  const raw: RawConfigMap = {};

  for (const row of configRows) {
    raw[row.key] = row.value;
  }

  const built = buildAppConfigFromRaw(raw);
  await trans.table<AppConfigRow, string>(APP_CONFIG_TABLE).put(built);

  // Migrate any legacy lastLocation_* keys into the dedicated last-locations table.
  const locationTable = trans.table<LastLocationRow, string>(LAST_LOCATION_TABLE);
  for (const row of configRows) {
    if (row.key.startsWith('lastLocation_')) {
      const docId = row.key.substring('lastLocation_'.length);
      await locationTable.put({ docId, location: row.value });
    }
  }
});

let dbOpenPromise: Promise<void> | null = null;
const cacheTextEncoder = new TextEncoder();

export async function initDB(): Promise<void> {
  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  dbOpenPromise = (async () => {
    try {
      console.log('Opening Dexie database...');
      emitDexieStatus('opening');
      const startedAt = Date.now();
      const stallTimer = setTimeout(() => {
        emitDexieStatus('stalled', { ms: Date.now() - startedAt });
      }, 4000);
      await db.open();
      await Promise.all([pruneDocumentCacheIfNeededInternal(), prunePreviewCacheIfNeededInternal()]).catch((error) => {
        console.warn('Dexie cache prune on open failed:', error);
      });
      clearTimeout(stallTimer);
      console.log('Dexie database opened successfully');
      emitDexieStatus('opened');
    } catch (error) {
      console.error('Dexie initialization error:', error);
      emitDexieStatus('error', { message: error instanceof Error ? error.message : String(error) });
      dbOpenPromise = null;
      throw error;
    }
  })();

  return dbOpenPromise;
}

async function withDB<T>(operation: () => Promise<T>): Promise<T> {
  await initDB();
  return operation();
}

type DocumentCacheTableName = typeof PDF_TABLE | typeof EPUB_TABLE | typeof HTML_TABLE;

type DocumentCacheEntryRef = {
  table: DocumentCacheTableName;
  id: string;
  byteSize: number;
  accessedAt: number;
};

function toPositiveInt(value: unknown, fallback: number = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(0, Math.floor(n));
}

function byteSizeForPdfRow(row: PDFCacheRow): number {
  const cached = toPositiveInt(row.cacheByteSize, 0);
  if (cached > 0) return cached;
  return row.data instanceof ArrayBuffer ? row.data.byteLength : toPositiveInt(row.size, 0);
}

function byteSizeForEpubRow(row: EPUBCacheRow): number {
  const cached = toPositiveInt(row.cacheByteSize, 0);
  if (cached > 0) return cached;
  return row.data instanceof ArrayBuffer ? row.data.byteLength : toPositiveInt(row.size, 0);
}

function byteSizeForHtmlRow(row: HTMLCacheRow): number {
  const cached = toPositiveInt(row.cacheByteSize, 0);
  if (cached > 0) return cached;
  if (typeof row.data === 'string') return cacheTextEncoder.encode(row.data).byteLength;
  return toPositiveInt(row.size, 0);
}

function accessedAtForRow(row: DocumentCacheMeta & { lastModified?: number }): number {
  return toPositiveInt(row.cacheAccessedAt, toPositiveInt(row.lastModified, Date.now()));
}

async function deleteDocumentCacheEntryInternal(table: DocumentCacheTableName, id: string): Promise<void> {
  if (table === PDF_TABLE) {
    await db[PDF_TABLE].delete(id);
    return;
  }
  if (table === EPUB_TABLE) {
    await db[EPUB_TABLE].delete(id);
    return;
  }
  await db[HTML_TABLE].delete(id);
}

async function pruneDocumentCacheIfNeededInternal(): Promise<void> {
  const budget = DOCUMENT_CACHE_MAX_BYTES;
  if (!Number.isFinite(budget) || budget <= 0) return;

  const [pdfRows, epubRows, htmlRows] = await Promise.all([
    db[PDF_TABLE].toArray(),
    db[EPUB_TABLE].toArray(),
    db[HTML_TABLE].toArray(),
  ]);

  const entries: DocumentCacheEntryRef[] = [];
  let totalBytes = 0;

  for (const row of pdfRows) {
    const byteSize = byteSizeForPdfRow(row);
    totalBytes += byteSize;
    entries.push({
      table: PDF_TABLE,
      id: row.id,
      byteSize,
      accessedAt: accessedAtForRow(row),
    });
  }
  for (const row of epubRows) {
    const byteSize = byteSizeForEpubRow(row);
    totalBytes += byteSize;
    entries.push({
      table: EPUB_TABLE,
      id: row.id,
      byteSize,
      accessedAt: accessedAtForRow(row),
    });
  }
  for (const row of htmlRows) {
    const byteSize = byteSizeForHtmlRow(row);
    totalBytes += byteSize;
    entries.push({
      table: HTML_TABLE,
      id: row.id,
      byteSize,
      accessedAt: accessedAtForRow(row),
    });
  }

  if (totalBytes <= budget) return;

  entries.sort((a, b) => a.accessedAt - b.accessedAt);
  for (const entry of entries) {
    if (totalBytes <= budget) break;
    await deleteDocumentCacheEntryInternal(entry.table, entry.id);
    totalBytes -= entry.byteSize;
  }
}

async function prunePreviewCacheIfNeededInternal(): Promise<void> {
  const budget = PREVIEW_CACHE_MAX_BYTES;
  if (!Number.isFinite(budget) || budget <= 0) return;

  const rows = await db[PREVIEW_CACHE_TABLE].toArray();
  let totalBytes = 0;
  const entries = rows.map((row) => {
    const byteSize = toPositiveInt(
      row.byteSize,
      row.data instanceof ArrayBuffer ? row.data.byteLength : 0,
    );
    totalBytes += byteSize;
    return {
      docId: row.docId,
      byteSize,
      accessedAt: toPositiveInt(row.cachedAt, 0),
    };
  });

  if (totalBytes <= budget) return;

  entries.sort((a, b) => a.accessedAt - b.accessedAt);
  for (const entry of entries) {
    if (totalBytes <= budget) break;
    await db[PREVIEW_CACHE_TABLE].delete(entry.docId);
    totalBytes -= entry.byteSize;
  }
}

function isSha256HexId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

async function getMappedDocumentId(docId: string): Promise<string> {
  if (isSha256HexId(docId)) return docId.toLowerCase();
  const row = await db[DOCUMENT_ID_MAP_TABLE].get(docId);
  return row?.id ?? docId;
}

export async function resolveDocumentId(docId: string): Promise<string> {
  return withDB(async () => getMappedDocumentId(docId));
}

async function recordDocumentIdMapping(oldId: string, id: string): Promise<void> {
  if (oldId === id) return;
  await db[DOCUMENT_ID_MAP_TABLE].put({ oldId, id, createdAt: Date.now() });
}

function rewriteDocumentListStateDocIds(state: DocumentListState, mapping: Map<string, string>): DocumentListState {
  let didChange = false;

  const folders = state.folders.map((folder) => {
    let folderChanged = false;
    const seen = new Set<string>();
    const documents: DocumentListDocument[] = [];

    for (const doc of folder.documents) {
      const mappedId = mapping.get(doc.id) ?? doc.id;
      if (mappedId !== doc.id) folderChanged = true;
      if (seen.has(mappedId)) {
        folderChanged = true;
        continue;
      }
      seen.add(mappedId);
      documents.push(mappedId === doc.id ? doc : { ...doc, id: mappedId });
    }

    if (!folderChanged) return folder;
    didChange = true;
    return { ...folder, documents };
  });

  return didChange ? { ...state, folders } : state;
}

async function applyDocumentIdMapping(oldId: string, newId: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) return;
  const nextId = newId.toLowerCase();

  await withDB(async () => {
    await db.transaction(
      'readwrite',
      [
        db[PDF_TABLE],
        db[EPUB_TABLE],
        db[HTML_TABLE],
        db[LAST_LOCATION_TABLE],
        db[APP_CONFIG_TABLE],
        db[DOCUMENT_ID_MAP_TABLE],
        db[PREVIEW_CACHE_TABLE],
      ],
      async () => {
        await recordDocumentIdMapping(oldId, nextId);

        const pdf = await db[PDF_TABLE].get(oldId);
        if (pdf) {
          const existing = await db[PDF_TABLE].get(nextId);
          if (existing) {
            const merged: PDFDocument = {
              ...pdf,
              ...existing,
              id: nextId,
              folderId: existing.folderId ?? pdf.folderId,
              name: existing.name || pdf.name,
            };
            await db[PDF_TABLE].put(merged);
            await db[PDF_TABLE].delete(oldId);
          } else {
            await db[PDF_TABLE].put({ ...pdf, id: nextId });
            await db[PDF_TABLE].delete(oldId);
          }
        }

        const epub = await db[EPUB_TABLE].get(oldId);
        if (epub) {
          const existing = await db[EPUB_TABLE].get(nextId);
          if (existing) {
            const merged: EPUBDocument = {
              ...epub,
              ...existing,
              id: nextId,
              folderId: existing.folderId ?? epub.folderId,
              name: existing.name || epub.name,
            };
            await db[EPUB_TABLE].put(merged);
            await db[EPUB_TABLE].delete(oldId);
          } else {
            await db[EPUB_TABLE].put({ ...epub, id: nextId });
            await db[EPUB_TABLE].delete(oldId);
          }
        }

        const html = await db[HTML_TABLE].get(oldId);
        if (html) {
          const existing = await db[HTML_TABLE].get(nextId);
          if (existing) {
            const merged: HTMLDocument = {
              ...html,
              ...existing,
              id: nextId,
              folderId: existing.folderId ?? html.folderId,
              name: existing.name || html.name,
            };
            await db[HTML_TABLE].put(merged);
            await db[HTML_TABLE].delete(oldId);
          } else {
            await db[HTML_TABLE].put({ ...html, id: nextId });
            await db[HTML_TABLE].delete(oldId);
          }
        }

        const oldLocation = await db[LAST_LOCATION_TABLE].get(oldId);
        if (oldLocation) {
          const newLocation = await db[LAST_LOCATION_TABLE].get(nextId);
          if (!newLocation) {
            await db[LAST_LOCATION_TABLE].put({ docId: nextId, location: oldLocation.location });
          }
          await db[LAST_LOCATION_TABLE].delete(oldId);
        }

        const preview = await db[PREVIEW_CACHE_TABLE].get(oldId);
        if (preview) {
          const existing = await db[PREVIEW_CACHE_TABLE].get(nextId);
          if (!existing || Number(existing.cachedAt ?? 0) < Number(preview.cachedAt ?? 0)) {
            await db[PREVIEW_CACHE_TABLE].put({ ...preview, docId: nextId });
          }
          await db[PREVIEW_CACHE_TABLE].delete(oldId);
        }

        const appConfig = await db[APP_CONFIG_TABLE].get('singleton');
        if (appConfig?.documentListState) {
          const mapped = rewriteDocumentListStateDocIds(appConfig.documentListState, new Map([[oldId, nextId]]));
          if (mapped !== appConfig.documentListState) {
            await db[APP_CONFIG_TABLE].update('singleton', { documentListState: mapped });
          }
        }
      },
    );
  });
}

export async function migrateLegacyDexieDocumentIdsToSha(): Promise<Array<{ oldId: string; id: string }>> {
  return withDB(async () => {
    const mappings: Array<{ oldId: string; id: string }> = [];

    const pdfDocs = await db[PDF_TABLE].toArray();
    for (const doc of pdfDocs) {
      if (isSha256HexId(doc.id)) continue;
      const id = await sha256HexFromBytes(new Uint8Array(doc.data));
      if (id !== doc.id) {
        mappings.push({ oldId: doc.id, id });
        await applyDocumentIdMapping(doc.id, id);
      }
    }

    const epubDocs = await db[EPUB_TABLE].toArray();
    for (const doc of epubDocs) {
      if (isSha256HexId(doc.id)) continue;
      const id = await sha256HexFromBytes(new Uint8Array(doc.data));
      if (id !== doc.id) {
        mappings.push({ oldId: doc.id, id });
        await applyDocumentIdMapping(doc.id, id);
      }
    }

    const htmlDocs = await db[HTML_TABLE].toArray();
    for (const doc of htmlDocs) {
      if (isSha256HexId(doc.id)) continue;
      const id = await sha256HexFromString(doc.data);
      if (id !== doc.id) {
        mappings.push({ oldId: doc.id, id });
        await applyDocumentIdMapping(doc.id, id);
      }
    }

    return mappings;
  });
}

export async function getDocumentIdMappings(): Promise<Array<{ oldId: string; id: string }>> {
  return withDB(async () => {
    const rows = await db[DOCUMENT_ID_MAP_TABLE].toArray();
    return rows.map((row) => ({ oldId: row.oldId, id: row.id }));
  });
}

// PDF document helpers

export async function addPdfDocument(document: PDFDocument): Promise<void> {
  await withDB(async () => {
    console.log('Adding PDF document via Dexie:', document.name);
    const now = Date.now();
    await db[PDF_TABLE].put({
      ...document,
      cacheCreatedAt: now,
      cacheAccessedAt: now,
      cacheByteSize: document.data.byteLength,
    });
    await pruneDocumentCacheIfNeededInternal();
  });
}

export async function getPdfDocument(id: string): Promise<PDFDocument | undefined> {
  return withDB(async () => {
    console.log('Fetching PDF document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    const row = await db[PDF_TABLE].get(resolved);
    if (row) {
      await db[PDF_TABLE].update(resolved, { cacheAccessedAt: Date.now() });
    }
    return row;
  });
}

export async function getAllPdfDocuments(): Promise<PDFDocument[]> {
  return withDB(async () => {
    console.log('Fetching all PDF documents via Dexie');
    return db[PDF_TABLE].toArray();
  });
}

export async function removePdfDocument(id: string): Promise<void> {
  await withDB(async () => {
    console.log('Removing PDF document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    await db.transaction('readwrite', db[PDF_TABLE], db[LAST_LOCATION_TABLE], db[PREVIEW_CACHE_TABLE], async () => {
      await db[PDF_TABLE].delete(resolved);
      await db[LAST_LOCATION_TABLE].delete(resolved);
      await db[PREVIEW_CACHE_TABLE].delete(resolved);
    });
  });
}

export async function clearPdfDocuments(): Promise<void> {
  await withDB(async () => {
    console.log('Clearing all PDF documents via Dexie');
    await db[PDF_TABLE].clear();
  });
}

// EPUB document helpers

export async function addEpubDocument(document: EPUBDocument): Promise<void> {
  await withDB(async () => {
    if (document.data.byteLength === 0) {
      throw new Error('Cannot store empty ArrayBuffer');
    }

    console.log('Adding EPUB document via Dexie:', {
      name: document.name,
      size: document.size,
      actualSize: document.data.byteLength,
    });

    const now = Date.now();
    await db[EPUB_TABLE].put({
      ...document,
      cacheCreatedAt: now,
      cacheAccessedAt: now,
      cacheByteSize: document.data.byteLength,
    });
    await pruneDocumentCacheIfNeededInternal();
  });
}

export async function getEpubDocument(id: string): Promise<EPUBDocument | undefined> {
  return withDB(async () => {
    console.log('Fetching EPUB document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    const row = await db[EPUB_TABLE].get(resolved);
    if (row) {
      await db[EPUB_TABLE].update(resolved, { cacheAccessedAt: Date.now() });
    }
    return row;
  });
}

export async function getAllEpubDocuments(): Promise<EPUBDocument[]> {
  return withDB(async () => {
    console.log('Fetching all EPUB documents via Dexie');
    return db[EPUB_TABLE].toArray();
  });
}

export async function removeEpubDocument(id: string): Promise<void> {
  await withDB(async () => {
    console.log('Removing EPUB document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    await db.transaction('readwrite', db[EPUB_TABLE], db[LAST_LOCATION_TABLE], db[PREVIEW_CACHE_TABLE], async () => {
      await db[EPUB_TABLE].delete(resolved);
      await db[LAST_LOCATION_TABLE].delete(resolved);
      await db[PREVIEW_CACHE_TABLE].delete(resolved);
    });
  });
}

export async function clearEpubDocuments(): Promise<void> {
  await withDB(async () => {
    console.log('Clearing all EPUB documents via Dexie');
    await db[EPUB_TABLE].clear();
  });
}

// HTML / text document helpers

export async function addHtmlDocument(document: HTMLDocument): Promise<void> {
  await withDB(async () => {
    console.log('Adding HTML document via Dexie:', document.name);
    const now = Date.now();
    await db[HTML_TABLE].put({
      ...document,
      cacheCreatedAt: now,
      cacheAccessedAt: now,
      cacheByteSize: cacheTextEncoder.encode(document.data).byteLength,
    });
    await pruneDocumentCacheIfNeededInternal();
  });
}

export async function getHtmlDocument(id: string): Promise<HTMLDocument | undefined> {
  return withDB(async () => {
    console.log('Fetching HTML document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    const row = await db[HTML_TABLE].get(resolved);
    if (row) {
      await db[HTML_TABLE].update(resolved, { cacheAccessedAt: Date.now() });
    }
    return row;
  });
}

export async function getAllHtmlDocuments(): Promise<HTMLDocument[]> {
  return withDB(async () => {
    console.log('Fetching all HTML documents via Dexie');
    return db[HTML_TABLE].toArray();
  });
}

export async function removeHtmlDocument(id: string): Promise<void> {
  await withDB(async () => {
    console.log('Removing HTML document via Dexie:', id);
    const resolved = await getMappedDocumentId(id);
    await db.transaction('readwrite', db[HTML_TABLE], db[PREVIEW_CACHE_TABLE], async () => {
      await db[HTML_TABLE].delete(resolved);
      await db[PREVIEW_CACHE_TABLE].delete(resolved);
    });
  });
}

export async function clearHtmlDocuments(): Promise<void> {
  await withDB(async () => {
    console.log('Clearing all HTML documents via Dexie');
    await db[HTML_TABLE].clear();
  });
}

export async function getAppConfig(): Promise<AppConfigRow | null> {
  return withDB(async () => {
    const row = await db[APP_CONFIG_TABLE].get('singleton');
    return row ?? null;
  });
}

export async function updateAppConfig(partial: Partial<AppConfigRow>): Promise<void> {
  await withDB(async () => {
    const table = db[APP_CONFIG_TABLE];
    const existing = await table.get('singleton');

    if (!existing) {
      await table.put({
        id: 'singleton',
        ...APP_CONFIG_DEFAULTS,
        ...partial,
      });
    } else {
      await table.update('singleton', partial);
    }
  });
}

// Document list state helpers

export async function saveDocumentListState(state: DocumentListState): Promise<void> {
  await updateAppConfig({ documentListState: state });
}

export async function getDocumentListState(): Promise<DocumentListState | null> {
  const config = await getAppConfig();
  if (!config || !config.documentListState) return null;
  return config.documentListState;
}

// Last-location helpers (used by TTS and readers)

export async function getLastDocumentLocation(docId: string): Promise<string | null> {
  return withDB(async () => {
    const resolved = await getMappedDocumentId(docId);
    const row = await db[LAST_LOCATION_TABLE].get(resolved);
    return row ? row.location : null;
  });
}

export async function setLastDocumentLocation(docId: string, location: string): Promise<void> {
  await withDB(async () => {
    const resolved = await getMappedDocumentId(docId);
    await db[LAST_LOCATION_TABLE].put({ docId: resolved, location });
  });
}

// First-visit helpers (used for onboarding/Settings modal)

export async function getFirstVisit(): Promise<boolean> {
  const config = await getAppConfig();
  return config?.firstVisit ?? false;
}

export async function setFirstVisit(value: boolean): Promise<void> {
  await updateAppConfig({ firstVisit: value });
}

// Document preview cache helpers

export async function getDocumentPreviewCache(docId: string): Promise<DocumentPreviewCacheRow | undefined> {
  return withDB(async () => {
    const resolved = await getMappedDocumentId(docId);
    const row = await db[PREVIEW_CACHE_TABLE].get(resolved);
    if (row) {
      await db[PREVIEW_CACHE_TABLE].update(resolved, { cachedAt: Date.now() });
    }
    return row;
  });
}

export async function putDocumentPreviewCache(row: DocumentPreviewCacheRow): Promise<void> {
  await withDB(async () => {
    const resolved = await getMappedDocumentId(row.docId);
    await db[PREVIEW_CACHE_TABLE].put({
      ...row,
      docId: resolved,
      cachedAt: Date.now(),
      byteSize: toPositiveInt(row.byteSize, row.data.byteLength),
    });
    await prunePreviewCacheIfNeededInternal();
  });
}

export async function removeDocumentPreviewCache(docId: string): Promise<void> {
  await withDB(async () => {
    const resolved = await getMappedDocumentId(docId);
    await db[PREVIEW_CACHE_TABLE].delete(resolved);
  });
}

export async function clearDocumentPreviewCache(): Promise<void> {
  await withDB(async () => {
    await db[PREVIEW_CACHE_TABLE].clear();
  });
}

// Sync helpers (server round-trip)

export async function syncDocumentsToServer(
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<{ lastSync: number }> {
  const pdfDocs = await getAllPdfDocuments();
  const epubDocs = await getAllEpubDocuments();
  const htmlDocs = await getAllHtmlDocuments();

  const uploads: Array<{ oldId: string; source: UploadSource }> = [];
  const totalDocs = pdfDocs.length + epubDocs.length + htmlDocs.length;
  let processedDocs = 0;

  const textEncoder = new TextEncoder();

  for (const doc of pdfDocs) {
    const bytes = new Uint8Array(doc.data);
    const id = await sha256HexFromBytes(bytes);
    uploads.push({
      oldId: doc.id,
      source: {
        id,
        name: doc.name,
        type: 'pdf',
        size: bytes.byteLength,
        lastModified: doc.lastModified,
        contentType: 'application/pdf',
        body: bytes,
      },
    });
    processedDocs++;
    if (onProgress) {
      onProgress((processedDocs / totalDocs) * 50, `Processing ${processedDocs}/${totalDocs} documents...`);
    }
  }

  for (const doc of epubDocs) {
    const bytes = new Uint8Array(doc.data);
    const id = await sha256HexFromBytes(bytes);
    uploads.push({
      oldId: doc.id,
      source: {
        id,
        name: doc.name,
        type: 'epub',
        size: bytes.byteLength,
        lastModified: doc.lastModified,
        contentType: 'application/epub+zip',
        body: bytes,
      },
    });
    processedDocs++;
    if (onProgress) {
      onProgress((processedDocs / totalDocs) * 50, `Processing ${processedDocs}/${totalDocs} documents...`);
    }
  }

  for (const doc of htmlDocs) {
    const encoded = textEncoder.encode(doc.data);
    const id = await sha256HexFromBytes(encoded);
    uploads.push({
      oldId: doc.id,
      source: {
        id,
        name: doc.name,
        type: 'html',
        size: encoded.byteLength,
        lastModified: doc.lastModified,
        contentType: 'text/plain; charset=utf-8',
        body: encoded,
      },
    });
    processedDocs++;
    if (onProgress) {
      onProgress((processedDocs / totalDocs) * 50, `Processing ${processedDocs}/${totalDocs} documents...`);
    }
  }

  if (onProgress) {
    onProgress(50, 'Uploading to server...');
  }

  await uploadDocumentSources(uploads.map((entry) => entry.source), { signal });

  for (const entry of uploads) {
    if (entry.oldId === entry.source.id) continue;
    await applyDocumentIdMapping(entry.oldId, entry.source.id);
  }

  if (onProgress) {
    onProgress(100, 'Upload complete!');
  }

  return { lastSync: Date.now() };
}

export async function syncSelectedDocumentsToServer(
  documents: BaseDocument[],
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<{ lastSync: number }> {
  const uploads: Array<{ oldId: string; source: UploadSource }> = [];
  const textEncoder = new TextEncoder();
  let processed = 0;

  for (const doc of documents) {
    if (doc.type === 'pdf') {
      const data = await getPdfDocument(doc.id);
      if (data) {
        const bytes = new Uint8Array(data.data);
        const id = await sha256HexFromBytes(bytes);
        uploads.push({
          oldId: data.id,
          source: {
            id,
            name: data.name,
            type: 'pdf',
            size: bytes.byteLength,
            lastModified: data.lastModified,
            contentType: 'application/pdf',
            body: bytes,
          },
        });
      }
    } else if (doc.type === 'epub') {
      const data = await getEpubDocument(doc.id);
      if (data) {
        const bytes = new Uint8Array(data.data);
        const id = await sha256HexFromBytes(bytes);
        uploads.push({
          oldId: data.id,
          source: {
            id,
            name: data.name,
            type: 'epub',
            size: bytes.byteLength,
            lastModified: data.lastModified,
            contentType: 'application/epub+zip',
            body: bytes,
          },
        });
      }
    } else {
      const data = await getHtmlDocument(doc.id);
      if (data) {
        const bytes = textEncoder.encode(data.data);
        const id = await sha256HexFromBytes(bytes);
        uploads.push({
          oldId: data.id,
          source: {
            id,
            name: data.name,
            type: 'html',
            size: bytes.byteLength,
            lastModified: data.lastModified,
            contentType: 'text/plain; charset=utf-8',
            body: bytes,
          },
        });
      }
    }

    processed++;
    if (onProgress) onProgress((processed / documents.length) * 50, `Preparing ${processed}/${documents.length}...`);
  }

  if (onProgress) onProgress(50, 'Uploading to server...');
  await uploadDocumentSources(uploads.map((entry) => entry.source), { signal });

  for (const entry of uploads) {
    if (entry.oldId === entry.source.id) continue;
    await applyDocumentIdMapping(entry.oldId, entry.source.id);
  }

  if (onProgress) {
    onProgress(100, 'Upload complete!');
  }

  return { lastSync: Date.now() };
}


export async function loadDocumentsFromServer(
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<{ lastSync: number }> {
  if (onProgress) {
    onProgress(10, 'Starting download...');
  }

  const documents = await listDocuments({ signal });
  await downloadAndCacheServerDocuments(documents, onProgress, signal);

  if (onProgress) {
    onProgress(100, 'Load complete!');
  }

  return { lastSync: Date.now() };
}

export async function loadSelectedDocumentsFromServer(
  selectedIds: string[],
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<{ lastSync: number }> {
  if (onProgress) {
    onProgress(10, 'Starting download...');
  }

  const documents = await listDocuments({ ids: selectedIds, signal });
  await downloadAndCacheServerDocuments(documents, onProgress, signal);

  if (onProgress) {
    onProgress(100, 'Load complete!');
  }

  return { lastSync: Date.now() };
}

async function downloadAndCacheServerDocuments(
  documents: BaseDocument[],
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
) {
  if (onProgress) onProgress(30, 'List complete');
  if (documents.length === 0) {
    if (onProgress) onProgress(95, 'No documents to import');
    return;
  }

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const bytes = await downloadDocumentContent(doc.id, { signal });
    await cacheStoredDocumentFromBytes(doc, bytes);
    if (onProgress) {
      onProgress(30 + ((i + 1) / documents.length) * 65, `Downloading ${i + 1}/${documents.length}: ${doc.name}`);
    }
  }
}


export async function importSelectedDocuments(
  documents: BaseDocument[],
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (documents.length === 0) return;

  const textDecoder = new TextDecoder();

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];

    if (onProgress) {
      onProgress(10 + (i / documents.length) * 85, `Downloading ${i + 1}/${documents.length}: ${doc.name}`);
    }

    const contentResponse = await fetch(`/api/documents/library/content?id=${encodeURIComponent(doc.id)}`, { signal });
    if (!contentResponse.ok) {
      console.warn(`Failed to download library document: ${doc.name}`);
      continue;
    }

    const buffer = await contentResponse.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (doc.type === 'pdf') {
      const localId = await sha256HexFromBytes(bytes);
      await addPdfDocument({
        id: localId,
        type: 'pdf',
        name: doc.name,
        size: bytes.byteLength,
        lastModified: doc.lastModified,
        data: buffer,
      });
    } else if (doc.type === 'epub') {
      const localId = await sha256HexFromBytes(bytes);
      await addEpubDocument({
        id: localId,
        type: 'epub',
        name: doc.name,
        size: bytes.byteLength,
        lastModified: doc.lastModified,
        data: buffer,
      });
    } else {
      const decoded = textDecoder.decode(bytes);
      const localId = await sha256HexFromString(decoded);
      await addHtmlDocument({
        id: localId,
        type: 'html',
        name: doc.name,
        size: bytes.byteLength,
        lastModified: doc.lastModified,
        data: decoded,
      });
    }

    if (onProgress) {
      onProgress(10 + ((i + 1) / documents.length) * 85, `Imported ${i + 1}/${documents.length}`);
    }
  }
}

export async function importDocumentsFromLibrary(
  onProgress?: (progress: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (onProgress) {
    onProgress(5, 'Scanning server library...');
  }

  const listResponse = await fetch('/api/documents/library', { signal });
  if (!listResponse.ok) {
    throw new Error('Failed to list library documents');
  }

  const { documents } = (await listResponse.json()) as { documents: BaseDocument[] };

  if (documents.length === 0) {
    if (onProgress) {
      onProgress(100, 'No documents found in server library');
    }
    return;
  }

  if (onProgress) {
    onProgress(10, `Found ${documents.length} documents. Importing...`);
  }

  await importSelectedDocuments(documents, onProgress, signal);

  if (onProgress) {
    onProgress(100, 'Library import complete!');
  }
}
