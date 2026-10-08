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
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export const EPUB_SECTION_POLICY = "script-src 'none'; object-src 'none'; frame-src 'none'";
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
}
