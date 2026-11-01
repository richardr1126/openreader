import { ApiRequestError } from '@/lib/server/api/responses';
import { fetchAndParseUrl } from './web-loader';
import { stageDocumentUpload, submitDocumentUpload, uploadId } from './uploads';
import { safeDocumentName } from './utils';
import type { DocumentCaller } from './request';

export async function createDocument(caller: DocumentCaller, body: Record<string, unknown>) {
  const source = body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'source is required.');
  const record = source as Record<string, unknown>;
  if (record.type === 'upload') {
    if (typeof record.uploadId !== 'string') throw new ApiRequestError(400, 'REQUEST_INVALID', 'uploadId is required.');
    return submitDocumentUpload(caller, uploadId(record.uploadId), body.folderId);
  }
  let text: string;
  let name: string;
  let author: string | null = null;
  let language: string | null = null;
  if (record.type === 'text') {
    if (typeof record.text !== 'string' || !record.text.trim()) throw new ApiRequestError(400, 'REQUEST_INVALID', 'text must be a non-empty string.');
    text = record.text;
    name = typeof body.name === 'string' && body.name.trim() ? safeDocumentName(body.name.trim(), 'document.txt') : 'document.txt';
    if (!/\.(txt|md|markdown|mdown|mkd)$/i.test(name)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Text documents need a text or Markdown filename.');
    author = typeof body.author === 'string' ? body.author : null;
    language = typeof body.language === 'string' ? body.language : null;
  } else if (record.type === 'url') {
    if (typeof record.url !== 'string' || !record.url.trim()) throw new ApiRequestError(400, 'REQUEST_INVALID', 'url is required.');
    let article;
    try { article = await fetchAndParseUrl(record.url); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'URL import failed.';
      throw new ApiRequestError(422, 'URL_IMPORT_FAILED', message);
    }
    text = article.content;
    const title = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : article.title || 'Imported Web Page';
    name = safeDocumentName(title.endsWith('.md') ? title : `${title.replace(/[/\\?%*:|"<>\s]+/g, '_').slice(0, 80)}.md`, 'document.md');
    author = article.author;
    language = article.language;
  } else throw new ApiRequestError(400, 'REQUEST_INVALID', 'source.type must be url, text or upload.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 2 * 1024 * 1024) throw new ApiRequestError(413, 'TEXT_TOO_LARGE', 'Text imports are limited to 2 MB.');
  const id = await stageDocumentUpload(caller, bytes, { name, author, language, contentType: name.endsWith('.txt') ? 'text/plain' : 'text/markdown' });
  return submitDocumentUpload(caller, id, body.folderId);
}
