import type { AppConfigValues, ViewType } from '@/types/config';
import type { ReaderType } from '@/types/user-state';

export interface ReaderPresentation {
  showsLayout: boolean;
  viewType: ViewType;
  epubTheme: boolean;
  highlightSegment: boolean;
  highlightWords: boolean;
}

export type HighlightVisibility = Pick<AppConfigValues, `${'pdf' | 'epub' | 'html'}${'HighlightEnabled' | 'WordHighlightEnabled'}`>;
export function getHighlightVisibility(config: HighlightVisibility): HighlightVisibility {
  return {
    pdfHighlightEnabled: config.pdfHighlightEnabled, pdfWordHighlightEnabled: config.pdfWordHighlightEnabled,
    epubHighlightEnabled: config.epubHighlightEnabled, epubWordHighlightEnabled: config.epubWordHighlightEnabled,
    htmlHighlightEnabled: config.htmlHighlightEnabled, htmlWordHighlightEnabled: config.htmlWordHighlightEnabled,
  };
}

export function normalizeReaderPresentationOverride(value: unknown): Partial<ReaderPresentation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Partial<ReaderPresentation> = {};
  for (const key of ['showsLayout', 'epubTheme', 'highlightSegment', 'highlightWords'] as const) {
    if (typeof record[key] === 'boolean') result[key] = record[key];
  }
  if (record.viewType === 'single' || record.viewType === 'dual' || record.viewType === 'scroll') result.viewType = record.viewType;
  return result;
}

export function resolveReaderPresentation(config: Pick<AppConfigValues,
  'pdfShowsLayout' | 'epubShowsLayout' | 'viewType' | 'epubTheme' | 'pdfHighlightEnabled' | 'pdfWordHighlightEnabled'
  | 'epubHighlightEnabled' | 'epubWordHighlightEnabled' | 'htmlHighlightEnabled' | 'htmlWordHighlightEnabled'>,
readerType: ReaderType, override?: Partial<ReaderPresentation>): ReaderPresentation {
  const prefix = readerType === 'pdf' ? 'pdf' : readerType === 'epub' ? 'epub' : 'html';
  return {
    showsLayout: readerType === 'pdf' ? config.pdfShowsLayout : readerType === 'epub' ? config.epubShowsLayout : false,
    viewType: config.viewType,
    epubTheme: config.epubTheme,
    highlightSegment: config[`${prefix}HighlightEnabled`],
    highlightWords: config[`${prefix}WordHighlightEnabled`],
    ...normalizeReaderPresentationOverride(override),
  };
}
