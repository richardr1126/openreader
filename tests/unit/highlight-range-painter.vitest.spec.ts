import { describe, expect, test, vi } from 'vitest';
import {
  clearRangeHighlight,
  paintRangeHighlight,
} from '@/lib/client/highlight-range-painter';

describe('range highlight painter', () => {
  test('updates a named highlight without mutating the text range', () => {
    const registry = { set: vi.fn(), delete: vi.fn(() => true) };
    class FakeHighlight {
      constructor(public range: Range) {}
    }
    const styles: Array<{ dataset: Record<string, string>; textContent: string }> = [];
    const document = {
      defaultView: { CSS: { highlights: registry }, Highlight: FakeHighlight },
      head: {
        querySelector: () => null,
        appendChild: (style: { dataset: Record<string, string>; textContent: string }) => styles.push(style),
      },
      createElement: () => ({ dataset: {}, textContent: '' }),
    } as unknown as Document;
    const range = {
      startContainer: { nodeType: 3, ownerDocument: document },
    } as unknown as Range;

    expect(paintRangeHighlight(range, 'openreader-word', 'background: purple;')).toBe(true);
    expect(registry.set).toHaveBeenCalledWith('openreader-word', expect.any(FakeHighlight));
    expect(styles[0]?.textContent).toContain('::highlight(openreader-word)');

    clearRangeHighlight(document, 'openreader-word');
    expect(registry.delete).toHaveBeenCalledWith('openreader-word');
  });

  test('updates the injected rule when the active theme color changes', () => {
    const registry = { set: vi.fn(), delete: vi.fn(() => true) };
    class FakeHighlight {
      constructor(public range: Range) {}
    }
    const style = { dataset: {}, textContent: 'old rule' };
    const document = {
      defaultView: { CSS: { highlights: registry }, Highlight: FakeHighlight },
      head: {
        querySelector: () => style,
        appendChild: vi.fn(),
      },
      createElement: vi.fn(),
    } as unknown as Document;
    const range = {
      startContainer: { nodeType: 3, ownerDocument: document },
    } as unknown as Range;

    paintRangeHighlight(range, 'openreader-word', 'background: #38bdf8;');
    expect(style.textContent).toContain('#38bdf8');
  });

  test('returns false when the Custom Highlight API is unavailable', () => {
    const document = {
      defaultView: { CSS: {} },
      head: { querySelector: () => null },
    } as unknown as Document;
    const range = {
      startContainer: { nodeType: 3, ownerDocument: document },
    } as unknown as Range;
    expect(paintRangeHighlight(range, 'openreader-word', 'background: purple;')).toBe(false);
  });
});
