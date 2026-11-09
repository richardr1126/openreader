import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetchExternal: vi.fn() }));
vi.mock('@/lib/server/external-fetch', () => ({ fetchExternal: state.fetchExternal }));

import { fetchUrlSource } from '@/lib/server/documents/web-loader';

function reply(contentType: string, body: string | Buffer, extra: { finalUrl?: string; contentDisposition?: string } = {}) {
  state.fetchExternal.mockResolvedValueOnce({
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType,
    contentDisposition: extra.contentDisposition ?? null,
    finalUrl: extra.finalUrl ?? 'https://example.test/files/paper.pdf',
  });
}

beforeEach(() => { state.fetchExternal.mockReset(); });

test('keeps a linked PDF as a file named from the URL, with a limit for files and one for pages', async () => {
  reply('application/pdf', '%PDF-1.7 body');
  const source = await fetchUrlSource('https://example.test/files/paper.pdf', 50 * 1024 * 1024);
  expect(source).toMatchObject({ kind: 'file', name: 'paper.pdf' });
  const { maxBytes } = state.fetchExternal.mock.calls[0][1];
  expect(maxBytes('application/pdf')).toBe(50 * 1024 * 1024);
  expect(maxBytes('text/html; charset=utf-8')).toBe(2 * 1024 * 1024);
});

test('names a file from Content-Disposition and lets an unlabelled download decide by its name', async () => {
  reply('application/octet-stream', 'PK\u0003\u0004 zip', { contentDisposition: 'attachment; filename="Moby Dick.epub"', finalUrl: 'https://example.test/download?id=1' });
  expect(await fetchUrlSource('https://example.test/download?id=1', 1024)).toMatchObject({ kind: 'file', name: 'Moby Dick.epub' });
  reply('text/plain', '# Notes', { finalUrl: 'https://example.test/README.md' });
  expect(await fetchUrlSource('https://example.test/README.md', 1024)).toMatchObject({ kind: 'file', name: 'README.md' });
  reply('application/octet-stream', 'data', { finalUrl: 'https://example.test/blob' });
  await expect(fetchUrlSource('https://example.test/blob', 1024)).rejects.toThrow('did not say what kind of file');
});

test('refuses a file whose bytes are not what the server said', async () => {
  reply('application/pdf', '<html>login</html>');
  await expect(fetchUrlSource('https://example.test/files/paper.pdf', 1024)).rejects.toThrow('valid PDF');
});

test('converts a web page to Markdown', async () => {
  reply('text/html; charset=utf-8', '<html lang="en"><head><title>Essay</title></head><body><article><h1>Essay</h1><p>'
    + 'A paragraph long enough for Readability to treat it as the article body. '.repeat(8) + '</p></article></body></html>',
  { finalUrl: 'https://example.test/essay' });
  const source = await fetchUrlSource('https://example.test/essay', 1024);
  expect(source).toMatchObject({ kind: 'page', title: 'Essay', language: 'en' });
  expect(source.kind === 'page' && source.content).toContain('A paragraph long enough');
});
