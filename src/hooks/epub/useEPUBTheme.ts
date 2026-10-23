import { useCallback, useEffect, useRef } from 'react';
import type { Contents, Rendition } from 'epubjs';
import { DEFAULT_TYPOGRAPHY, READER_FONT_FAMILIES, type ReaderTypography } from '@/lib/shared/reader-appearance';

export const useEPUBTheme = (epubTheme: boolean, rendition: Rendition | undefined, typography: ReaderTypography = DEFAULT_TYPOGRAPHY, onReflow?: () => void) => {
  const typographyKey = JSON.stringify(typography);
  const reflow = useRef(onReflow);
  reflow.current = onReflow;
  const applyToDocument = useCallback((doc: Document) => {
    const value = JSON.parse(typographyKey) as ReaderTypography;
    const colors = getComputedStyle(document.documentElement);
    const rules: string[] = [];
    if (epubTheme) rules.push(`body {color:${colors.getPropertyValue('--foreground')} !important;background:${colors.getPropertyValue('--base')} !important;}`);
    if (value.fontFamily !== 'default') rules.push(`body, body * {font-family:${READER_FONT_FAMILIES[value.fontFamily]} !important;}`);
    if (value.sizePercent !== 100) rules.push(`html {font-size:${value.sizePercent}% !important;} body {font-size:1rem !important;}`);
    if (value.lineMultiplier !== 1.5) rules.push(`body, p, li {line-height:${value.lineMultiplier} !important;}`);
    if (value.paragraphSpacing !== 1) rules.push(`p {margin-block:${value.paragraphSpacing}em !important;}`);
    if (value.letterSpacing !== 0) rules.push(`body, p, li {letter-spacing:${value.letterSpacing}em !important;}`);
    if (value.alignment !== 'default') rules.push(`body, p {text-align:${value.alignment} !important;}`);
    let style = doc.getElementById('openreader-appearance');
    if (!style) { style = doc.createElement('style'); style.id = 'openreader-appearance'; doc.head.appendChild(style); }
    // Replacing one owned sheet restores publisher rules on reset.
    if (style.textContent !== rules.join('\n')) style.textContent = rules.join('\n');
  }, [epubTheme, typographyKey]);
  const updateTheme = useCallback(() => {
    if (!rendition?.book?.isOpen) return;
    for (const contents of rendition.getContents() as unknown as Contents[]) applyToDocument(contents.document);
  }, [rendition, applyToDocument]);

  useEffect(() => {
    if (!rendition) return;
    // Apply before the initial section is measured, including sections opened
    // after a page turn. Rendered is retained for already mounted contents.
    const prepare = (contents: Contents) => applyToDocument(contents.document);
    rendition.hooks.content.register(prepare);
    rendition.on('rendered', updateTheme);
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      rendition.hooks.content.deregister(prepare);
      rendition.off('rendered', updateTheme);
      observer.disconnect();
    };
  }, [rendition, applyToDocument, updateTheme]);

  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!rendition || previous.current === typographyKey) return;
    const hadValue = previous.current !== undefined;
    previous.current = typographyKey;
    if (!hadValue) return;
    // Reuse the placement owner after metrics change; keep the audio cursor.
    const frame = requestAnimationFrame(() => reflow.current?.());
    return () => cancelAnimationFrame(frame);
  }, [rendition, typographyKey]);
  return { updateTheme };
};
