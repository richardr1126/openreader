import { useEffect, RefObject, useState } from 'react';
import { debounce } from '@/lib/client/pdf';

export function useEPUBResize(containerRef: RefObject<HTMLDivElement | null>) {
  const [isResizing, setIsResizing] = useState(false);
  const [dimensions, setDimensions] = useState<DOMRectReadOnly | null>(null);
  
  useEffect(() => {    
    const debouncedResize = debounce((...args: unknown[]) => {
      const entries = args[0] as ResizeObserverEntry[];
      console.log('Debounced resize', entries[0].contentRect);
      setDimensions(entries[0].contentRect);
      setIsResizing((prev) => {
        if (!prev) return true;
        return prev;
      });
    }, 150);

    const resizeObserver = new ResizeObserver((entries) => {
      // if (!isResizing) {
      //   setIsResizing(true);
      // }
      debouncedResize(entries);
    });

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
          const container = containerRef.current?.querySelector('.epub-container');
          if (container) {
            console.log('Observer attached to epub-container');
            resizeObserver.observe(container);
            mutationObserver.disconnect();
            break;
          }
        }
      }
    });

    if (containerRef.current) {
      mutationObserver.observe(containerRef.current, {
        childList: true,
        subtree: true
      });

      const container = containerRef.current.querySelector('.epub-container');
      if (container) {
        console.log('Container already exists, attaching observer');
        resizeObserver.observe(container);
        mutationObserver.disconnect();
      }
    }

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  return { isResizing, setIsResizing, dimensions };
}