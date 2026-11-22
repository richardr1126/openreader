/**
 * EPUB sections render in iframes sandboxed with `allow-same-origin`. WebKit
 * does not dispatch events to listeners inside a sandboxed frame that lacks
 * `allow-scripts`, even listeners registered by the parent app, so tap-to-seek,
 * its hover affordance, and other reader listeners never fire in Safari.
 *
 * The rendition therefore enables `allow-scripts`, and every section is made
 * script-free before it is serialized into its frame: book scripts, inline
 * event handlers, and `javascript:` URLs are removed, and a Content Security
 * Policy forbidding script and plugin content is pinned as the first element of
 * the head. Only the app's own listeners, which live in the parent realm, run.
 *
 * The same policy keeps opening a book offline: epub.js serves packaged
 * resources as blob or data URLs, so only those and the app's own origin load.
 * Remote images, stylesheets, imports and fonts never request their host.
 * Inline styles stay allowed for publisher and reader appearance sheets.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export const EPUB_SECTION_POLICY = [
  "default-src 'self' blob: data:",
  "style-src 'self' blob: data: 'unsafe-inline'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');
// Hints open connections or fetch outside the policy's reach and serve no
// purpose in a section frame.
const RESOURCE_HINTS = new Set(['preconnect', 'dns-prefetch', 'prefetch', 'preload', 'modulepreload', 'prerender']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data']);

export function hardenEpubSection(doc: Document): void {
  const root = doc.documentElement;
  if (!root) return;

  for (const element of Array.from(root.querySelectorAll('*'))) {
    const name = element.localName.toLowerCase();
    if (name === 'script' || name === 'object' || name === 'embed' || name === 'iframe') {
      element.remove();
      continue;
    }
    if (name === 'link' && (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).some((rel) => RESOURCE_HINTS.has(rel))) {
      element.remove();
      continue;
    }
    // A refresh navigates the section frame without script, and no policy
    // directive governs that navigation.
    if (name === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if (
        URL_ATTRIBUTES.has(attributeName)
        && /^\s*javascript:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  let head = Array.from(root.children).find((child) => child.localName.toLowerCase() === 'head');
  if (!head) {
    head = doc.createElementNS(root.namespaceURI ?? XHTML_NS, 'head');
    root.insertBefore(head, root.firstChild);
  }
  const meta = doc.createElementNS(head.namespaceURI ?? XHTML_NS, 'meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', EPUB_SECTION_POLICY);
  head.insertBefore(meta, head.firstChild);
  // Browsers resolve link hosts ahead of a click, which also reveals the book.
  const dnsPrefetch = doc.createElementNS(head.namespaceURI ?? XHTML_NS, 'meta');
  dnsPrefetch.setAttribute('http-equiv', 'x-dns-prefetch-control');
  dnsPrefetch.setAttribute('content', 'off');
  head.insertBefore(dnsPrefetch, meta.nextSibling);
}
