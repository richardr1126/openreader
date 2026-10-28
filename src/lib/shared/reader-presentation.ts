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

type HighlightLayers = Pick<ReaderPresentation, 'highlightSegment' | 'highlightWords'>;
const HIGHLIGHT_FORMATS = ['pdf', 'epub', 'html'] as const;

/** The app default shows a layer while any format shows it. */
export function appHighlightLayers(visibility: HighlightVisibility): HighlightLayers {
  return {
    highlightSegment: HIGHLIGHT_FORMATS.some(format => visibility[`${format}HighlightEnabled`]),
    highlightWords: HIGHLIGHT_FORMATS.some(format => visibility[`${format}WordHighlightEnabled`]),
  };
}

/** Changing an app default layer sets it for every format. */
export function setAppHighlightLayers(visibility: HighlightVisibility, patch: Partial<HighlightLayers>): HighlightVisibility {
  const next = { ...visibility };
  for (const format of HIGHLIGHT_FORMATS) {
    if (patch.highlightSegment !== undefined) next[`${format}HighlightEnabled`] = patch.highlightSegment;
    if (patch.highlightWords !== undefined) next[`${format}WordHighlightEnabled`] = patch.highlightWords;
  }
  return next;
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
