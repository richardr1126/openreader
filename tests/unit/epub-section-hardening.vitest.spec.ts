import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { EPUB_SECTION_POLICY, hardenEpubSection } from '@/lib/client/epub/epub-section-hardening';

function parseSection(body: string, head = '<title>Chapter</title>'): Document {
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>${head}</head><body>${body}</body></html>`;
  return new DOMParser().parseFromString(xhtml, 'text/xml') as unknown as Document;
}

describe('hardenEpubSection', () => {
  it('removes book scripts, handlers, embeds, and javascript URLs but keeps reading content', () => {
    const doc = parseSection(
      '<p onclick="steal()">Once upon a time.</p>'
      + '<script>steal()</script>'
      + '<a href="javascript:steal()">bad</a><a href="chapter2.xhtml">next</a>'
      + '<object data="x.swf"></object><iframe src="https://example.com"></iframe>'
      + '<img src="cover.jpg" alt="Cover"/>',
      '<script src="book.js"></script><title>Chapter</title>',
    );

    hardenEpubSection(doc);

    expect(doc.getElementsByTagName('script')).toHaveLength(0);
    expect(doc.getElementsByTagName('object')).toHaveLength(0);
    expect(doc.getElementsByTagName('iframe')).toHaveLength(0);
    const paragraph = doc.getElementsByTagName('p')[0];
    expect(paragraph.hasAttribute('onclick')).toBe(false);
    expect(paragraph.textContent).toBe('Once upon a time.');
    const links = Array.from(doc.getElementsByTagName('a'));
    expect(links[0].hasAttribute('href')).toBe(false);
    expect(links[1].getAttribute('href')).toBe('chapter2.xhtml');
    expect(doc.getElementsByTagName('img')[0].getAttribute('src')).toBe('cover.jpg');
  });

  it('pins the script-free policy as the first element of the head', () => {
    const doc = parseSection('<p>Text.</p>');

    hardenEpubSection(doc);

    const head = doc.getElementsByTagName('head')[0];
    const first = head.firstElementChild;
    expect(first?.localName).toBe('meta');
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(EPUB_SECTION_POLICY);
  });

  it('creates a head when the section has none', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text.</p></body></html>',
      'text/xml',
    ) as unknown as Document;

    hardenEpubSection(doc);

    const root = doc.documentElement;
    expect(root.firstElementChild?.localName).toBe('head');
    expect(root.firstElementChild?.firstElementChild?.getAttribute('content')).toBe(EPUB_SECTION_POLICY);
  });
});
