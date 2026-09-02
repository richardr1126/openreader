import { useCallback, useEffect } from 'react';
import { Rendition } from 'epubjs';

export const useEPUBTheme = (epubTheme: boolean, rendition: Rendition | undefined) => {
  const updateTheme = useCallback(() => {
    if (!epubTheme || !rendition) return;
    const maybeBook = (rendition as unknown as { book?: { isOpen?: boolean } }).book;
    if (!maybeBook?.isOpen) return;

    const colors = {
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground'),
      base: getComputedStyle(document.documentElement).getPropertyValue('--base'),
    };

    try {
      // Register theme rules instead of using override
      rendition.themes.registerRules('theme-light', {
        'body': {
          'color': colors.foreground,
          'background-color': colors.base
        }
      });

      // Select the theme to apply it
      rendition.themes.select('theme-light');
    } catch (error) {
      console.warn('Failed to apply EPUB theme rules:', error);
    }
  }, [epubTheme, rendition]);

  // Watch for theme changes
  useEffect(() => {
    if (!epubTheme || !rendition) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          updateTheme();
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    return () => observer.disconnect();
  }, [epubTheme, rendition, updateTheme]);

  // Watch for epubTheme changes
  useEffect(() => {
    if (!epubTheme || !rendition) return;
    updateTheme();
  }, [epubTheme, rendition, updateTheme]);

  // Ensure theme is applied once the rendition has fully rendered/opened.
  useEffect(() => {
    if (!epubTheme || !rendition) return;
    const emitter = rendition as unknown as {
      on?: (event: string, callback: () => void) => void;
      off?: (event: string, callback: () => void) => void;
    };
    if (!emitter.on) return;

    const handleRendered = () => {
      updateTheme();
    };
    emitter.on('rendered', handleRendered);
    return () => {
      emitter.off?.('rendered', handleRendered);
    };
  }, [epubTheme, rendition, updateTheme]);

  return { updateTheme };
};
