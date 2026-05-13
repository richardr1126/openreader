'use client';

const EPUB_CONTINUATION_CHARS = 5000;

const stepToNextNode = (node: Node | null, root: Node): Node | null => {
  if (!node) return null;
  if (node.firstChild) return node.firstChild;

  let current: Node | null = node;
  while (current) {
    if (current === root) return null;
    if (current.nextSibling) return current.nextSibling;
    current = current.parentNode;
  }
  return null;
};

const stepToPreviousNode = (node: Node | null, root: Node): Node | null => {
  if (!node) return null;

  if (node.previousSibling) {
    let prev: Node | null = node.previousSibling;
    while (prev?.lastChild) prev = prev.lastChild;
    return prev;
  }

  let current: Node | null = node.parentNode;
  while (current) {
    if (current === root) return null;
    if (current.previousSibling) {
      let prev: Node | null = current.previousSibling;
      while (prev?.lastChild) prev = prev.lastChild;
      return prev;
    }
    current = current.parentNode;
  }
  return null;
};

const getNextTextNode = (node: Node | null, root: Node): Text | null => {
  let next = stepToNextNode(node, root);
  while (next) {
    if (next.nodeType === Node.TEXT_NODE) return next as Text;
    next = stepToNextNode(next, root);
  }
  return null;
};

const getPreviousTextNode = (node: Node | null, root: Node): Text | null => {
  let prev = stepToPreviousNode(node, root);
  while (prev) {
    if (prev.nodeType === Node.TEXT_NODE) return prev as Text;
    prev = stepToPreviousNode(prev, root);
  }
  return null;
};

const getLastTextNodeInSubtree = (node: Node | null): Text | null => {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node as Text;

  let child: Node | null = node.lastChild;
  while (child) {
    const nested = getLastTextNodeInSubtree(child);
    if (nested) return nested;
    child = child.previousSibling;
  }
  return null;
};

export const collectContinuationFromRange = (
  range: Range | null | undefined,
  limit = EPUB_CONTINUATION_CHARS,
): string => {
  if (typeof window === 'undefined' || !range) return '';
  const root = range.commonAncestorContainer;
  if (!root) return '';

  const parts: string[] = [];
  let remaining = limit;

  const appendFromTextNode = (textNode: Text, offset: number) => {
    if (remaining <= 0) return;
    const textContent = textNode.textContent || '';
    if (offset >= textContent.length) return;
    const slice = textContent.slice(offset, offset + remaining);
    if (slice) {
      parts.push(slice);
      remaining -= slice.length;
    }
  };

  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    appendFromTextNode(range.endContainer as Text, range.endOffset);
    let nextNode = getNextTextNode(range.endContainer, root);
    while (nextNode && remaining > 0) {
      appendFromTextNode(nextNode, 0);
      nextNode = getNextTextNode(nextNode, root);
    }
  } else {
    let nextNode = getNextTextNode(range.endContainer, root);
    while (nextNode && remaining > 0) {
      appendFromTextNode(nextNode, 0);
      nextNode = getNextTextNode(nextNode, root);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

export const collectLeadingContextFromRange = (
  range: Range | null | undefined,
  limit = EPUB_CONTINUATION_CHARS,
): string => {
  if (typeof window === 'undefined' || !range) return '';
  const root = range.commonAncestorContainer;
  if (!root) return '';

  const parts: string[] = [];
  let remaining = limit;

  const prependFromTextNode = (textNode: Text, endOffset: number) => {
    if (remaining <= 0) return;
    const textContent = textNode.textContent || '';
    const safeEnd = Math.max(0, Math.min(endOffset, textContent.length));
    if (safeEnd <= 0) return;
    const safeStart = Math.max(0, safeEnd - remaining);
    const slice = textContent.slice(safeStart, safeEnd);
    if (slice) {
      parts.unshift(slice);
      remaining -= slice.length;
    }
  };

  let cursor: Node | null = null;
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const startText = range.startContainer as Text;
    prependFromTextNode(startText, range.startOffset);
    cursor = startText;
  } else {
    const startNode = range.startContainer;
    let anchor: Node | null = null;
    if (range.startOffset > 0) {
      anchor = startNode.childNodes[range.startOffset - 1] ?? null;
    }
    if (!anchor) {
      anchor = stepToPreviousNode(startNode, root);
    }

    const anchorText = getLastTextNodeInSubtree(anchor);
    if (anchorText) {
      prependFromTextNode(anchorText, (anchorText.textContent || '').length);
      cursor = anchorText;
    } else {
      cursor = anchor;
    }
  }

  let prevNode = getPreviousTextNode(cursor, root);
  while (prevNode && remaining > 0) {
    prependFromTextNode(prevNode, (prevNode.textContent || '').length);
    prevNode = getPreviousTextNode(prevNode, root);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
