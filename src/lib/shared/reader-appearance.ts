/** Presentation preferences never contribute to a playback plan or audio key. */
export interface ReaderTypography {
  fontFamily: 'default' | 'serif' | 'sans' | 'rounded' | 'mono';
  sizePercent: number;
  lineMultiplier: number;
  paragraphSpacing: number;
  letterSpacing: number;
  readingWidth: number;
  alignment: 'default' | 'left' | 'justify';
}
export interface HighlightAppearance {
  /** `theme` preserves each renderer's existing theme-based appearance. */
  segmentColor: string;
  wordColor: string;
  segmentOpacity: number;
  wordOpacity: number;
}
export const DEFAULT_TYPOGRAPHY: ReaderTypography = {
  fontFamily: 'default', sizePercent: 100, lineMultiplier: 1.5,
  paragraphSpacing: 1, letterSpacing: 0, readingWidth: 100, alignment: 'default',
};
export const DEFAULT_HIGHLIGHT_APPEARANCE: HighlightAppearance = {
  segmentColor: 'theme', wordColor: 'theme', segmentOpacity: 0.22, wordOpacity: 0.55,
};
export const TYPOGRAPHY_RANGES = {
  sizePercent: [75, 160, 5], lineMultiplier: [1.1, 2.2, 0.1],
  paragraphSpacing: [0.25, 2, 0.25], letterSpacing: [0, 0.12, 0.01],
  readingWidth: [40, 100, 10],
} as const;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function normalizeTypographyOverride(value: unknown): Partial<ReaderTypography> {
  const rec = record(value);
  const out: Partial<ReaderTypography> = {};
  if (['default', 'serif', 'sans', 'rounded', 'mono'].includes(String(rec.fontFamily))) out.fontFamily = rec.fontFamily as ReaderTypography['fontFamily'];
  if (['default', 'left', 'justify'].includes(String(rec.alignment))) out.alignment = rec.alignment as ReaderTypography['alignment'];
  for (const key of Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [min, max, step] = TYPOGRAPHY_RANGES[key];
    out[key] = Number(Math.min(max, Math.max(min, Math.round(v / step) * step)).toFixed(2));
  }
  return out;
}
export function normalizeTypography(value: unknown): ReaderTypography {
  return { ...DEFAULT_TYPOGRAPHY, ...normalizeTypographyOverride(value) };
}
export function normalizeHighlightOverride(value: unknown): Partial<HighlightAppearance> {
  const rec = record(value);
  const out: Partial<HighlightAppearance> = {};
  for (const key of ['segmentColor', 'wordColor'] as const) {
    if (typeof rec[key] === 'string' && /^(theme|#[\da-f]{6})$/i.test(rec[key] as string)) out[key] = (rec[key] as string).toLowerCase();
  }
  for (const key of ['segmentOpacity', 'wordOpacity'] as const) {
    if (typeof rec[key] === 'number' && Number.isFinite(rec[key])) out[key] = Math.max(0, Math.min(1, rec[key] as number));
  }
  return out;
}
export function normalizeHighlightAppearance(value: unknown): HighlightAppearance {
  return { ...DEFAULT_HIGHLIGHT_APPEARANCE, ...normalizeHighlightOverride(value) };
}
export const HIGHLIGHT_PRESETS: Record<string, HighlightAppearance> = {
  Theme: DEFAULT_HIGHLIGHT_APPEARANCE,
  Amber: { segmentColor: '#fbbf24', wordColor: '#f59e0b', segmentOpacity: 0.2, wordOpacity: 0.5 },
  Ocean: { segmentColor: '#38bdf8', wordColor: '#2563eb', segmentOpacity: 0.2, wordOpacity: 0.5 },
  Mint: { segmentColor: '#4ade80', wordColor: '#10b981', segmentOpacity: 0.2, wordOpacity: 0.5 },
};
export const READER_FONT_FAMILIES: Record<ReaderTypography['fontFamily'], string> = {
  default: '', serif: 'Georgia, "Times New Roman", serif', sans: 'system-ui, sans-serif',
  rounded: 'ui-rounded, system-ui, sans-serif', mono: 'ui-monospace, monospace',
};
export function highlightBackground(appearance: HighlightAppearance, layer: 'segment' | 'word', fallbackColor = 'var(--accent)', fallbackOpacity?: number): string {
  const color = appearance[`${layer}Color`];
  const opacity = appearance[`${layer}Opacity`];
  const baseline = DEFAULT_HIGHLIGHT_APPEARANCE[`${layer}Opacity`];
  return `color-mix(in srgb, ${color === 'theme' ? fallbackColor : color} ${(fallbackOpacity !== undefined && opacity === baseline ? fallbackOpacity : opacity) * 100}%, transparent)`;
}
