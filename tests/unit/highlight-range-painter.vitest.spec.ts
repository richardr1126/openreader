import { describe, expect, test, vi } from 'vitest';
import {
  clearRangeHighlight,
  paintRangeHighlight,
} from '@/lib/client/highlight-range-painter';

describe('range highlight painter', () => {
  test('updates a named highlight without mutating the text range', () => {
    const registry = { get: vi.fn(), set: vi.fn(), delete: vi.fn(() => true) };
    class FakeHighlight extends Set<Range> {
      constructor(range: Range) { super([range]); }
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

    const registered = registry.set.mock.calls[0][1] as FakeHighlight;
    registry.get.mockReturnValue(registered);
    clearRangeHighlight(document, 'openreader-word');
    expect(registered.size).toBe(0);
    expect(registry.delete).not.toHaveBeenCalled();
  });

  test('updates the injected rule when the active theme color changes', () => {
    const registry = { get: vi.fn(), set: vi.fn(), delete: vi.fn(() => true) };
    class FakeHighlight extends Set<Range> {
      constructor(range: Range) { super([range]); }
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

  test('rapid hover updates invalidate old ranges without replacing the registered highlight', () => {
    const registry = new Map<string, Set<Range>>();
    const register = vi.spyOn(registry, 'set');
    const document = {
      defaultView: { CSS: { highlights: registry }, Highlight: Set },
      head: { querySelector: () => ({ textContent: '' }) },
    } as unknown as Document;
    class FakeHighlight extends Set<Range> {
      constructor(...ranges: Range[]) { super(ranges); }
    }
    Object.assign(document.defaultView!, { Highlight: FakeHighlight });
    const range = () => ({
      startContainer: { nodeType: 3, ownerDocument: document },
    }) as unknown as Range;

    const first = range();
    paintRangeHighlight(first, 'hover', 'background: purple;');
    const highlight = registry.get('hover')!;
    const invalidate = vi.spyOn(highlight, 'clear');
    for (let i = 0; i < 250; i += 1) {
      const next = range();
      paintRangeHighlight(next, 'hover', 'background: purple;');
      expect(registry.get('hover')).toBe(highlight);
      expect([...highlight]).toEqual([next]);
      expect(highlight.has(first)).toBe(false);
    }
    expect(register).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(250);

    const otherRange = range();
    paintRangeHighlight(otherRange, 'playing', 'background: blue;');
    clearRangeHighlight(document, 'hover');
    expect(highlight.size).toBe(0);
    expect(registry.get('hover')).toBe(highlight);
    expect([...registry.get('playing')!]).toEqual([otherRange]);
  });

  test('repainting an unchanged range leaves the highlight untouched', () => {
    const registry = new Map<string, Set<Range> & { priority?: number }>();
    class FakeHighlight extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) { super(ranges); }
    }
    const document = {
      defaultView: { CSS: { highlights: registry }, Highlight: FakeHighlight },
      head: { querySelector: () => ({ textContent: '' }) },
    } as unknown as Document;
    const text = { nodeType: 3, ownerDocument: document };
    const range = (start: number, end: number) => ({
      startContainer: text, startOffset: start, endContainer: text, endOffset: end,
    }) as unknown as Range;

    paintRangeHighlight(range(0, 5), 'word', 'background: blue;', 1);
    const highlight = registry.get('word')!;
    expect(highlight.priority).toBe(1);
    const invalidate = vi.spyOn(highlight, 'clear');

    paintRangeHighlight(range(0, 5), 'word', 'background: blue;', 1);
    expect(invalidate).not.toHaveBeenCalled();

    paintRangeHighlight(range(6, 9), 'word', 'background: blue;', 1);
    expect(invalidate).toHaveBeenCalledOnce();

    clearRangeHighlight(document, 'word');
    clearRangeHighlight(document, 'word');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
