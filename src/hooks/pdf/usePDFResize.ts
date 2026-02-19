import { RefObject, useState, useEffect } from 'react';
import { debounce } from '@/lib/client/pdf';

interface UsePDFResizeResult {
  containerWidth: number;
  containerHeight: number;
  setContainerWidth: (width: number) => void;
}

export function usePDFResize(
  containerRef: RefObject<HTMLDivElement | null>
): UsePDFResizeResult {
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const debouncedResize = debounce((width: unknown) => {
      setContainerWidth(Number(width));
    }, 150);

    const debouncedResizeHeight = debounce((height: unknown) => {
      setContainerHeight(Number(height));
    }, 150);

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      const height = entries[0]?.contentRect.height;

      if (width) debouncedResize(width);
      if (height) debouncedResizeHeight(height);
    });

    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  return { containerWidth, containerHeight, setContainerWidth };
}