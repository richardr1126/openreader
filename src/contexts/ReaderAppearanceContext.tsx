'use client';

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { useConfig } from './ConfigContext';
import type { DocumentSettings } from '@/types/document-settings';
import { DEFAULT_HIGHLIGHT_APPEARANCE, normalizeTypography, normalizeHighlightAppearance } from '@/lib/shared/reader-appearance';

type BookAppearance = Pick<DocumentSettings, 'typography' | 'highlightAppearance'>;
const ReaderAppearanceContext = createContext<{
  settings: BookAppearance;
  update: (patch: BookAppearance) => Promise<void>;
} | null>(null);

/** One presentation owner shared by the three renderers and their settings. */
export function ReaderAppearanceProvider({ settings, update, children }: {
  settings: BookAppearance; update: (patch: BookAppearance) => Promise<void>; children: ReactNode;
}) {
  const config = useConfig();
  const appearance = normalizeHighlightAppearance({ ...config.highlightAppearance, ...settings.highlightAppearance });
  const style: Record<string, string | undefined> = {};
  for (const layer of ['segment', 'word'] as const) {
    style[`--reader-${layer}-color`] = appearance[`${layer}Color`] === 'theme' ? undefined : appearance[`${layer}Color`];
    style[`--reader-${layer}-opacity`] = appearance[`${layer}Opacity`] === DEFAULT_HIGHLIGHT_APPEARANCE[`${layer}Opacity`] ? undefined : String(appearance[`${layer}Opacity`]);
  }
  return <ReaderAppearanceContext.Provider value={{ settings, update }}><div className="contents" style={style as CSSProperties}>{children}</div></ReaderAppearanceContext.Provider>;
}
export function useReaderAppearance() {
  const config = useConfig();
  const book = useContext(ReaderAppearanceContext);
  return {
    typography: normalizeTypography({ ...config.readerTypography, ...book?.settings.typography }),
    highlights: normalizeHighlightAppearance({ ...config.highlightAppearance, ...book?.settings.highlightAppearance }),
    book,
  };
}
