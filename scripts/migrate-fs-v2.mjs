#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as dotenv from 'dotenv';
import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const BetterSqlite3 = require('better-sqlite3');
const ffmpegStatic = require('ffmpeg-static');

const DOCSTORE_DIR = path.join(process.cwd(), 'docstore');
const DOCUMENTS_V1_DIR = path.join(DOCSTORE_DIR, 'documents_v1');
const AUDIOBOOKS_V1_DIR = path.join(DOCSTORE_DIR, 'audiobooks_v1');
const UNCLAIMED_USER_ID = 'unclaimed';

const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const SAFE_AUDIOBOOK_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;

function loadEnvFiles() {
  const envPath = path.join(process.cwd(), '.env');
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  if (fs.existsSync(envLocalPath)) dotenv.config({ path: envLocalPath, override: true });
}

function parseBool(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    deleteLocal: false,
    namespace: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--dry-run' && argv[i + 1]) {
      args.dryRun = parseBool(argv[i + 1], true);
      i += 1;
      continue;
    }
    if (raw.startsWith('--dry-run=')) {
      args.dryRun = parseBool(raw.slice('--dry-run='.length), true);
      continue;
    }
    if (raw === '--delete-local' && argv[i + 1]) {
      args.deleteLocal = parseBool(argv[i + 1], true);
      i += 1;
      continue;
    }
    if (raw.startsWith('--delete-local=')) {
      args.deleteLocal = parseBool(raw.slice('--delete-local='.length), true);
      continue;
    }
    if (raw === '--namespace' && argv[i + 1]) {
      args.namespace = sanitizeNamespace(argv[i + 1]);
      i += 1;
      continue;
    }
    if (raw.startsWith('--namespace=')) {
      args.namespace = sanitizeNamespace(raw.slice('--namespace='.length));
    }
  }

  return args;
}

function sanitizeNamespace(namespace) {
  if (!namespace) return null;
  const safe = String(namespace).trim();
  if (!safe || !SAFE_NAMESPACE_REGEX.test(safe)) return null;
  return safe;
}

function applyNamespacePath(baseDir, namespace) {
  if (!namespace) return baseDir;
  const resolved = path.resolve(baseDir, namespace);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return baseDir;
  return resolved;
}

function getUnclaimedUserIdForNamespace(namespace) {
  if (!namespace) return UNCLAIMED_USER_ID;
  return `${UNCLAIMED_USER_ID}::${namespace}`;
}

function normalizePrefix(prefix) {
  const base = String(prefix || 'openreader').trim();
  if (!base) return 'openreader';
  return base.replace(/^\/+|\/+$/g, '');
}

function parseS3ConfigFromEnv() {
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim();

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 is not configured. Required env vars: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
  }

  return {
    bucket,
    region,
    endpoint: endpoint || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBool(process.env.S3_FORCE_PATH_STYLE, false),
    prefix: normalizePrefix(process.env.S3_PREFIX),
  };
}

function createS3Client(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function isPreconditionFailed(error) {
  if (!error || typeof error !== 'object') return false;
  return error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed';
}

function documentKey(s3Config, id, namespace) {
  if (!DOCUMENT_ID_REGEX.test(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }
  const nsSegment = namespace ? `ns/${namespace}/` : '';
  return `${s3Config.prefix}/documents_v1/${nsSegment}${id}`;
}

function audiobookKey(s3Config, bookId, userId, fileName, namespace) {
  if (!SAFE_AUDIOBOOK_ID_REGEX.test(bookId)) throw new Error(`Invalid audiobook id: ${bookId}`);
  if (!userId) throw new Error('Missing user id for audiobook key');
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) throw new Error(`Invalid audiobook file name: ${fileName}`);
  const nsSegment = namespace ? `ns/${namespace}/` : '';
  return `${s3Config.prefix}/audiobooks_v1/${nsSegment}users/${encodeURIComponent(String(userId))}/${bookId}-audiobook/${fileName}`;
}

async function putObjectIfMissing(s3Client, s3Config, key, body, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: s3Config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    IfNoneMatch: '*',
  }));
}

function isLegacyDocumentMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  const v = value;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.size === 'number'
    && typeof v.lastModified === 'number'
    && typeof v.type === 'string';
}

function isValidDocumentId(id) {
  return DOCUMENT_ID_REGEX.test(id);
}

function extractIdFromFileName(fileName) {
  const match = /^([a-f0-9]{64})__/i.exec(fileName);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return isValidDocumentId(id) ? id : null;
}

function decodeNameFromFileName(fileName, id) {
  const prefix = `${id}__`;
  if (!fileName.startsWith(prefix)) return fileName;
  const encoded = fileName.slice(prefix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return fileName;
  }
}

function sniffBinaryDocumentType(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf';
  }

  const isZip = bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
  if (!isZip) return null;

  const probe = bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)).toString('latin1');
  if (probe.includes('application/epub+zip') || probe.includes('META-INF/container.xml')) return 'epub';
  if (probe.includes('[Content_Types].xml') && probe.includes('word/')) return 'docx';
  return null;
}

function toDocumentTypeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.docx') return 'docx';
  return 'html';
}

function safeDocumentName(rawName, fallback) {
  const baseName = path.basename(rawName || fallback);
  return baseName.replaceAll('\u0000', '').slice(0, 240) || fallback;
}

function normalizeNameForType(name, id, type) {
  if (type === 'html') return name;
  const expectedExt = type === 'pdf' ? '.pdf' : type === 'epub' ? '.epub' : '.docx';
  if (name.toLowerCase().endsWith(expectedExt)) return name;
  const base = name.replace(/\.bin$/i, '');
  return `${base || id}${expectedExt}`;
}

function contentTypeForName(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.epub') return 'application/epub+zip';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.md' || ext === '.mdown' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function contentTypeForDocument(type, name) {
  if (type === 'pdf') return 'application/pdf';
  if (type === 'epub') return 'application/epub+zip';
  if (type === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return contentTypeForName(name);
}

function sanitizeTagValue(value) {
  return String(value || '').replaceAll('\u0000', '').replaceAll(/\r?\n/g, ' ').trim();
}

function sanitizeFileStem(value) {
  return sanitizeTagValue(value)
    .replaceAll(/[\\/]/g, ' ')
    .replaceAll(/[<>:"|?*\u0000]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function encodeChapterFileName(index, title, format) {
  const oneBased = String(index + 1).padStart(4, '0');
  const safeTitle = sanitizeFileStem(title) || `Chapter ${index + 1}`;
  return `${oneBased}__${encodeURIComponent(safeTitle)}.${format}`;
}

function decodeChapterFileName(fileName) {
  const match = /^(\d{1,6})__(.+)\.(mp3|m4b)$/i.exec(fileName);
  if (!match) return null;
  const oneBased = Number(match[1]);
  if (!Number.isInteger(oneBased) || oneBased <= 0) return null;
  const format = match[3].toLowerCase();
  try {
    const title = decodeURIComponent(match[2]);
    return { index: oneBased - 1, title: title || `Chapter ${oneBased}`, format };
  } catch {
    return { index: oneBased - 1, title: match[2], format };
  }
}

function decodeChapterTitleTag(tag) {
  const raw = sanitizeTagValue(tag);
  if (!raw) return null;
  const match = /^(\d{1,6})\s*[-.:]\s*(.+)$/.exec(raw);
  if (!match) return null;
  const oneBased = Number(match[1]);
  if (!Number.isFinite(oneBased) || !Number.isInteger(oneBased) || oneBased <= 0) return null;
  return { index: oneBased - 1, title: match[2].trim() || `Chapter ${oneBased}` };
}

function chooseBinary(preferred, bundled, envVarName, packageName) {
  const envValue = preferred ? String(preferred).trim() : '';
  if (envValue) {
    if ((envValue.includes('/') || envValue.includes('\\')) && !fs.existsSync(envValue)) {
      throw new Error(`${envVarName} points to a missing binary: ${envValue}`);
    }
    return envValue;
  }

  const bundledValue = bundled ? String(bundled).trim() : '';
  if (!bundledValue) {
    throw new Error(`${packageName} binary is unavailable on this platform. Set ${envVarName} to an installed binary path.`);
  }
  if ((bundledValue.includes('/') || bundledValue.includes('\\')) && !fs.existsSync(bundledValue)) {
    throw new Error(`${packageName} resolved to a missing binary path: ${bundledValue}`);
  }
  return bundledValue;
}

function getFFmpegPath() {
  return chooseBinary(process.env.FFMPEG_BIN || null, ffmpegStatic || null, 'FFMPEG_BIN', 'ffmpeg-static');
}

async function ffprobeTitleTag(filePath) {
  return new Promise((resolve) => {
    const child = spawn(getFFmpegPath(), [
      '-i', filePath,
      '-f', 'ffmetadata',
      '-',
    ]);

    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('title='));
      if (!line) {
        resolve(null);
        return;
      }
      const raw = line.slice('title='.length).trim();
      resolve(raw.length > 0 ? raw : null);
    });
  });
}

function isPersistedAudiobookFileName(fileName) {
  if (fileName === 'audiobook.meta.json') return true;
  if (fileName === 'complete.mp3' || fileName === 'complete.m4b') return true;
  if (/^complete\.(mp3|m4b)\.manifest\.json$/i.test(fileName)) return true;
  return decodeChapterFileName(fileName) !== null;
}

function isTransientAudiobookFileName(fileName) {
  if (/^-?\d+-input\.mp3$/i.test(fileName)) return true;
  if (/\.tmp\./i.test(fileName)) return true;
  return false;
}

function contentTypeForAudiobookFileName(fileName) {
  if (fileName.endsWith('.mp3')) return 'audio/mpeg';
  if (fileName.endsWith('.m4b')) return 'audio/mp4';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function collectDocumentCandidates(docsDir, docstoreDir) {
  const byId = new Map();
  let filesScanned = 0;
  let skippedInvalid = 0;

  if (fs.existsSync(docsDir)) {
    const entries = await fsp.readdir(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      filesScanned += 1;
      const fullPath = path.join(docsDir, entry.name);
      const bytes = await fsp.readFile(fullPath);
      const st = await fsp.stat(fullPath);

      const extractedId = extractIdFromFileName(entry.name);
      const id = extractedId ?? createHash('sha256').update(bytes).digest('hex');
      if (!isValidDocumentId(id)) {
        skippedInvalid += 1;
        continue;
      }

      const inferredName = decodeNameFromFileName(entry.name, id);
      const inferredType = toDocumentTypeFromName(inferredName);
      const type = inferredType === 'html' ? (sniffBinaryDocumentType(bytes) ?? inferredType) : inferredType;
      const normalizedName = normalizeNameForType(inferredName, id, type);
      const contentType = contentTypeForDocument(type, normalizedName);
      const lastModified = Number.isFinite(st.mtimeMs) ? Math.floor(st.mtimeMs) : Date.now();

      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: normalizedName,
          type,
          size: bytes.length,
          lastModified,
          contentType,
          bytes,
          localPaths: new Set([fullPath]),
        });
      } else {
        byId.get(id).localPaths.add(fullPath);
      }
    }
  }

  if (fs.existsSync(docstoreDir)) {
    const entries = await fsp.readdir(docstoreDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const metadataPath = path.join(docstoreDir, entry.name);
      let parsed;
      try {
        parsed = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
      } catch {
        continue;
      }
      if (!isLegacyDocumentMetadata(parsed)) continue;

      const contentPath = path.join(docstoreDir, `${parsed.id}.${parsed.type}`);
      if (!fs.existsSync(contentPath)) continue;

      filesScanned += 1;
      const bytes = await fsp.readFile(contentPath);
      const st = await fsp.stat(contentPath);
      const id = createHash('sha256').update(bytes).digest('hex');
      if (!isValidDocumentId(id)) {
        skippedInvalid += 1;
        continue;
      }

      const fallbackName = `${id}.${parsed.type}`;
      const normalizedInputName = safeDocumentName(parsed.name, fallbackName);
      const inferredType = toDocumentTypeFromName(normalizedInputName);
      const type = inferredType === 'html' ? (sniffBinaryDocumentType(bytes) ?? inferredType) : inferredType;
      const normalizedName = normalizeNameForType(normalizedInputName, id, type);
      const contentType = contentTypeForDocument(type, normalizedName);
      const lastModified = Number.isFinite(st.mtimeMs) ? Math.floor(st.mtimeMs) : Date.now();

      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: normalizedName,
          type,
          size: bytes.length,
          lastModified,
          contentType,
          bytes,
          localPaths: new Set([contentPath, metadataPath]),
        });
      } else {
        byId.get(id).localPaths.add(contentPath);
        byId.get(id).localPaths.add(metadataPath);
      }
    }
  }

  return {
    candidates: Array.from(byId.values()).map((item) => ({
      ...item,
      localPaths: Array.from(item.localPaths),
    })),
    filesScanned,
    skippedInvalid,
  };
}

async function collectAudiobookCandidates(audiobooksDir, docstoreDir) {
  const stats = {
    booksScanned: 0,
    filesScanned: 0,
    skippedTransient: 0,
  };

  const sourceDirs = new Map();

  if (fs.existsSync(audiobooksDir)) {
    const entries = await fsp.readdir(audiobooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('-audiobook')) continue;
      const bookId = entry.name.slice(0, -'-audiobook'.length);
      if (!SAFE_AUDIOBOOK_ID_REGEX.test(bookId)) continue;
      sourceDirs.set(`${bookId}::${path.join(audiobooksDir, entry.name)}`, {
        bookId,
        dirPath: path.join(audiobooksDir, entry.name),
      });
    }
  }

  if (fs.existsSync(docstoreDir)) {
    const entries = await fsp.readdir(docstoreDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('-audiobook')) continue;
      const bookId = entry.name.slice(0, -'-audiobook'.length);
      if (!SAFE_AUDIOBOOK_ID_REGEX.test(bookId)) continue;
      sourceDirs.set(`${bookId}::${path.join(docstoreDir, entry.name)}`, {
        bookId,
        dirPath: path.join(docstoreDir, entry.name),
      });
    }
  }

  const grouped = new Map();
  for (const source of sourceDirs.values()) {
    if (!grouped.has(source.bookId)) grouped.set(source.bookId, []);
    grouped.get(source.bookId).push(source.dirPath);
  }

  const books = [];
  for (const [bookId, dirPaths] of grouped.entries()) {
    stats.booksScanned += 1;

    const uploads = [];
    const dedupedChapterByIndex = new Map();
    let title = 'Unknown Title';

    for (const dirPath of dirPaths) {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
      const chapterMetaByIndex = new Map();

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name === 'audiobook.meta.json') continue;
        if (!entry.name.endsWith('.meta.json')) continue;
        const metaPath = path.join(dirPath, entry.name);
        try {
          const raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
          const idx = Number(raw?.index ?? entry.name.replace(/\.meta\.json$/i, ''));
          const chapterTitle = typeof raw?.title === 'string' ? raw.title : null;
          if (Number.isInteger(idx) && idx >= 0 && chapterTitle) {
            chapterMetaByIndex.set(idx, chapterTitle);
          }
        } catch { }
      }

      const unresolvedSha = [];
      const usedIndices = new Set();
      const chapterUploads = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        stats.filesScanned += 1;

        if (isTransientAudiobookFileName(fileName)) {
          stats.skippedTransient += 1;
          continue;
        }

        const fullPath = path.join(dirPath, fileName);
        const st = await fsp.stat(fullPath).catch(() => null);
        const mtimeMs = Number(st?.mtimeMs ?? 0);

        const canonical = decodeChapterFileName(fileName);
        if (canonical) {
          const targetFileName = encodeChapterFileName(canonical.index, canonical.title, canonical.format);
          chapterUploads.push({
            index: canonical.index,
            title: canonical.title,
            format: canonical.format,
            targetFileName,
            sourcePath: fullPath,
            mtimeMs,
          });
          usedIndices.add(canonical.index);
          continue;
        }

        if (isPersistedAudiobookFileName(fileName)) {
          uploads.push({
            sourcePath: fullPath,
            targetFileName: fileName,
            contentType: contentTypeForAudiobookFileName(fileName),
          });
          continue;
        }

        const legacy = /^(\d+)-chapter\.(mp3|m4b)$/i.exec(fileName);
        if (legacy) {
          const index = Number(legacy[1]);
          const format = legacy[2].toLowerCase();
          const chapterTitle = chapterMetaByIndex.get(index) ?? `Chapter ${index + 1}`;
          const targetFileName = encodeChapterFileName(index, chapterTitle, format);
          chapterUploads.push({
            index,
            title: chapterTitle,
            format,
            targetFileName,
            sourcePath: fullPath,
            mtimeMs,
          });
          usedIndices.add(index);
          continue;
        }

        const sha = /^[a-f0-9]{64}\.(mp3|m4b)$/i.test(fileName);
        if (sha) {
          unresolvedSha.push({
            sourcePath: fullPath,
            format: fileName.toLowerCase().endsWith('.mp3') ? 'mp3' : 'm4b',
            mtimeMs,
          });
          continue;
        }
      }

      unresolvedSha.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
      const nextIndex = () => {
        let idx = 0;
        while (usedIndices.has(idx)) idx += 1;
        usedIndices.add(idx);
        return idx;
      };

      for (const item of unresolvedSha) {
        let decoded = null;
        const titleTag = await ffprobeTitleTag(item.sourcePath);
        if (titleTag) decoded = decodeChapterTitleTag(titleTag);
        const index = decoded?.index ?? nextIndex();
        const chapterTitle = decoded?.title ?? `Chapter ${index + 1}`;
        const targetFileName = encodeChapterFileName(index, chapterTitle, item.format);
        chapterUploads.push({
          index,
          title: chapterTitle,
          format: item.format,
          targetFileName,
          sourcePath: item.sourcePath,
          mtimeMs: item.mtimeMs,
        });
      }

      for (const chapter of chapterUploads) {
        uploads.push({
          sourcePath: chapter.sourcePath,
          targetFileName: chapter.targetFileName,
          contentType: contentTypeForAudiobookFileName(chapter.targetFileName),
        });

        const current = dedupedChapterByIndex.get(chapter.index);
        if (!current || chapter.targetFileName > current.fileName || chapter.mtimeMs > current.mtimeMs) {
          dedupedChapterByIndex.set(chapter.index, {
            index: chapter.index,
            title: chapter.title,
            format: chapter.format,
            fileName: chapter.targetFileName,
            mtimeMs: chapter.mtimeMs,
          });
        }
      }
    }

    const chapters = Array.from(dedupedChapterByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map((chapter) => ({
        index: chapter.index,
        title: chapter.title,
        format: chapter.format,
        fileName: chapter.fileName,
      }));

    if (chapters.length > 0) title = chapters[0].title || title;

    books.push({
      id: bookId,
      title,
      chapters,
      uploads,
      sourceDirs: dirPaths,
    });
  }

  return { books, stats };
}

function openDatabase() {
  if (process.env.POSTGRES_URL) {
    const pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    return {
      mode: 'pg',
      async query(sql, values = []) {
        return pool.query(sql, values);
      },
      async close() {
        await pool.end();
      },
    };
  }

  const dbPath = path.join(process.cwd(), 'docstore', 'sqlite3.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new BetterSqlite3(dbPath);
  return {
    mode: 'sqlite',
    async query(sql, values = []) {
      if (/^\s*select/i.test(sql)) {
        const rows = sqlite.prepare(sql).all(...values);
        return { rows, rowCount: rows.length };
      }
      const info = sqlite.prepare(sql).run(...values);
      return { rows: [], rowCount: Number(info.changes ?? 0) };
    },
    async close() {
      sqlite.close();
    },
  };
}

async function migrateDatabaseRows(database, userId, docCandidates, audiobookBooks, dryRun) {
  const mismatched = await database.query('SELECT COUNT(*) AS count FROM documents WHERE file_path <> id');
  const rowsUpdated = Number(mismatched.rows[0]?.count ?? mismatched.rows[0]?.COUNT ?? 0);
  if (!dryRun && rowsUpdated > 0) {
    await database.query('UPDATE documents SET file_path = id WHERE file_path <> id');
  }

  // Ensure the user exists to satisfy foreign key constraints (cascade delete)
  if (!dryRun) {
    const now = Date.now();
    if (database.mode === 'sqlite') {
      await database.query(
        'INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at, is_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, 'System User', `${userId}@local`, 0, now, now, 0]
      );
    } else {
      await database.query(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at, is_anonymous) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7) ON CONFLICT (id) DO NOTHING",
        [userId, 'System User', `${userId}@local`, false, now, now, false]
      );
    }
  }

  const existingDocs = database.mode === 'sqlite'
    ? await database.query('SELECT id FROM documents WHERE user_id = ?', [userId])
    : await database.query('SELECT id FROM documents WHERE user_id = $1', [userId]);
  const existingDocIds = new Set(existingDocs.rows.map((row) => row.id));
  const toInsertDocs = docCandidates.filter((candidate) => !existingDocIds.has(candidate.id));

  if (!dryRun) {
    for (const candidate of toInsertDocs) {
      if (database.mode === 'sqlite') {
        await database.query(
          'INSERT OR IGNORE INTO documents (id, user_id, name, type, size, last_modified, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [candidate.id, userId, candidate.name, candidate.type, candidate.size, candidate.lastModified, candidate.id],
        );
      } else {
        await database.query(
          'INSERT INTO documents (id, user_id, name, type, size, last_modified, file_path) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
          [candidate.id, userId, candidate.name, candidate.type, candidate.size, candidate.lastModified, candidate.id],
        );
      }
    }

    for (const book of audiobookBooks) {
      if (database.mode === 'sqlite') {
        await database.query(
          'INSERT OR IGNORE INTO audiobooks (id, user_id, title, duration) VALUES (?, ?, ?, ?)',
          [book.id, userId, book.title || 'Unknown Title', 0],
        );
      } else {
        await database.query(
          'INSERT INTO audiobooks (id, user_id, title, duration) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [book.id, userId, book.title || 'Unknown Title', 0],
        );
      }

      for (const chapter of book.chapters) {
        const chapterId = `${book.id}-${chapter.index}`;
        if (database.mode === 'sqlite') {
          await database.query(
            'INSERT OR IGNORE INTO audiobook_chapters (id, book_id, user_id, chapter_index, title, duration, file_path, format) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [chapterId, book.id, userId, chapter.index, chapter.title, 0, chapter.fileName, chapter.format],
          );
        } else {
          await database.query(
            'INSERT INTO audiobook_chapters (id, book_id, user_id, chapter_index, title, duration, file_path, format) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING',
            [chapterId, book.id, userId, chapter.index, chapter.title, 0, chapter.fileName, chapter.format],
          );
        }
      }
    }
  }

  return {
    dbRowsUpdated: rowsUpdated,
    dbRowsSeeded: toInsertDocs.length,
    audiobookDbBooksSeeded: audiobookBooks.length,
    audiobookDbChaptersSeeded: audiobookBooks.reduce((sum, book) => sum + book.chapters.length, 0),
  };
}

async function main() {
  loadEnvFiles();
  const { dryRun, deleteLocal, namespace } = parseArgs(process.argv.slice(2));
  const unclaimedUserId = getUnclaimedUserIdForNamespace(namespace);
  const docsDir = applyNamespacePath(DOCUMENTS_V1_DIR, namespace);
  const audiobooksDir = applyNamespacePath(AUDIOBOOKS_V1_DIR, namespace);
  const docstoreDir = applyNamespacePath(DOCSTORE_DIR, namespace);

  const s3Config = parseS3ConfigFromEnv();
  const s3Client = createS3Client(s3Config);

  const { candidates: documentCandidates, filesScanned, skippedInvalid } = await collectDocumentCandidates(docsDir, docstoreDir);
  const { books: audiobookBooks, stats: audiobookStats } = await collectAudiobookCandidates(audiobooksDir, docstoreDir);

  let uploaded = 0;
  let alreadyPresent = 0;
  let deletedLocal = 0;

  for (const candidate of documentCandidates) {
    if (!dryRun) {
      try {
        await putObjectIfMissing(
          s3Client,
          s3Config,
          documentKey(s3Config, candidate.id, namespace),
          candidate.bytes,
          candidate.contentType,
        );
        uploaded += 1;
      } catch (error) {
        if (isPreconditionFailed(error)) {
          alreadyPresent += 1;
        } else {
          throw error;
        }
      }
    }

    if (deleteLocal && !dryRun) {
      for (const localPath of candidate.localPaths) {
        const removed = await fsp.unlink(localPath).then(() => true).catch(() => false);
        if (removed) deletedLocal += 1;
      }
    }
  }

  let audiobookUploaded = 0;
  let audiobookAlreadyPresent = 0;
  let audiobookDeletedLocal = 0;

  for (const book of audiobookBooks) {
    for (const upload of book.uploads) {
      const bytes = await fsp.readFile(upload.sourcePath);
      if (!dryRun) {
        try {
          await putObjectIfMissing(
            s3Client,
            s3Config,
            audiobookKey(s3Config, book.id, unclaimedUserId, upload.targetFileName, namespace),
            bytes,
            upload.contentType,
          );
          audiobookUploaded += 1;
        } catch (error) {
          if (isPreconditionFailed(error)) {
            audiobookAlreadyPresent += 1;
          } else {
            throw error;
          }
        }
      }

      if (deleteLocal && !dryRun) {
        const removed = await fsp.unlink(upload.sourcePath).then(() => true).catch(() => false);
        if (removed) audiobookDeletedLocal += 1;
      }
    }

    if (deleteLocal && !dryRun) {
      for (const dirPath of book.sourceDirs) {
        await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => { });
      }
    }
  }

  const database = openDatabase();
  try {
    const dbStats = await migrateDatabaseRows(
      database,
      unclaimedUserId,
      documentCandidates,
      audiobookBooks,
      dryRun,
    );

    const result = {
      success: true,
      dryRun,
      deleteLocal,
      docsDir,
      audiobooksDir,
      namespace,
      filesScanned,
      uploaded,
      alreadyPresent,
      skippedInvalid,
      deletedLocal,
      dbRowsUpdated: dbStats.dbRowsUpdated,
      dbRowsSeeded: dbStats.dbRowsSeeded,
      audiobookBooksScanned: audiobookStats.booksScanned,
      audiobookFilesScanned: audiobookStats.filesScanned,
      audiobookUploaded,
      audiobookAlreadyPresent,
      audiobookDeletedLocal,
      audiobookSkippedTransient: audiobookStats.skippedTransient,
      audiobookDbBooksSeeded: dbStats.audiobookDbBooksSeeded,
      audiobookDbChaptersSeeded: dbStats.audiobookDbChaptersSeeded,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error('Error running v2 migration script:', error);
  process.exit(1);
});
