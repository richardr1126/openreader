import type { LayoutRegion, PdfTextItem } from './types';

const NON_TEXT_REGION_LABELS = new Set<LayoutRegion['label']>(['chart', 'image', 'table', 'seal']);
const TEXT_ASSIGNABLE_LABELS = new Set<LayoutRegion['label']>([
  'abstract',
  'algorithm',
  'aside_text',
  'content',
  'doc_title',
  'figure_title',
  'footer',
  'footnote',
  'formula_number',
  'header',
  'number',
  'paragraph_title',
  'reference',
  'reference_content',
  'text',
  'vision_footnote',
  'formula',
]);

function centroid(item: PdfTextItem): { x: number; y: number } {
  return {
    x: item.x + item.width / 2,
    y: item.y + item.height / 2,
  };
}

function contains(region: LayoutRegion, item: PdfTextItem): boolean {
  const c = centroid(item);
  return c.x >= region.bbox[0] && c.x <= region.bbox[2] && c.y >= region.bbox[1] && c.y <= region.bbox[3];
}

function sortReadingOrder(items: PdfTextItem[]): PdfTextItem[] {
  const tolerance = 2;
  return [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) <= tolerance) return a.x - b.x;
    return a.y - b.y;
  });
}

function joinText(items: PdfTextItem[]): string {
  let out = '';
  let prev: PdfTextItem | null = null;
  for (const item of items) {
    if (!prev) {
      out += item.text;
      prev = item;
      continue;
    }
    const prevEndX = prev.x + prev.width;
    const gap = item.x - prevEndX;
    const lineJump = item.y - prev.y;
    const lineBreak = lineJump > Math.max(2, Math.min(prev.height, item.height) * 0.6);
    const avgCharWidth = item.width / Math.max(1, item.text.length);
    const needsSpace = lineBreak || gap > Math.max(avgCharWidth * 0.3, 2);
    out += needsSpace ? ` ${item.text}` : item.text;
    prev = item;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function regionArea(region: LayoutRegion): number {
  return Math.max(1, (region.bbox[2] - region.bbox[0]) * (region.bbox[3] - region.bbox[1]));
}

function regionScore(region: LayoutRegion): number {
  return Number.isFinite(region.confidence) ? Number(region.confidence) : 0;
}

export interface RegionTextBlock {
  region: LayoutRegion;
  text: string;
  items: PdfTextItem[];
  sourceOrder: number;
}

export function mergeTextWithRegions(regions: LayoutRegion[], textItems: PdfTextItem[]): RegionTextBlock[] {
  const sourceIndex = new Map<PdfTextItem, number>();
  for (let i = 0; i < textItems.length; i += 1) {
    sourceIndex.set(textItems[i]!, i);
  }

  const chunkSourceOrder = (items: PdfTextItem[]): number => {
    let min = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const index = sourceIndex.get(item);
      if (typeof index === 'number' && index < min) min = index;
    }
    return Number.isFinite(min) ? min : Number.MAX_SAFE_INTEGER;
  };

  const assignableRegions = regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => TEXT_ASSIGNABLE_LABELS.has(region.label));
  const assignedByRegion = new Map<number, PdfTextItem[]>();

  for (const item of textItems) {
    const candidates = assignableRegions.filter(({ region }) => contains(region, item));
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const scoreDelta = regionScore(b.region) - regionScore(a.region);
      if (Math.abs(scoreDelta) > 1e-6) return scoreDelta;
      return regionArea(a.region) - regionArea(b.region);
    });

    const winner = candidates[0];
    const list = assignedByRegion.get(winner.index) ?? [];
    list.push(item);
    assignedByRegion.set(winner.index, list);
  }

  const out: RegionTextBlock[] = [];

  for (const [regionIndex, assignedItems] of assignedByRegion.entries()) {
    const region = regions[regionIndex];
    if (!region) continue;
    if (assignedItems.length === 0) continue;
    const ordered = sortReadingOrder(assignedItems);
    const text = joinText(ordered);
    if (!text) continue;

    out.push({
      region,
      text,
      items: ordered,
      sourceOrder: chunkSourceOrder(ordered),
    });
  }

  for (const region of regions) {
    if (!NON_TEXT_REGION_LABELS.has(region.label)) continue;
    out.push({
      region,
      text: '',
      items: [],
      sourceOrder: Number.MAX_SAFE_INTEGER,
    });
  }

  out.sort((a, b) => {
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    const ay = a.region.bbox[1];
    const by = b.region.bbox[1];
    if (Math.abs(ay - by) <= 2) return a.region.bbox[0] - b.region.bbox[0];
    return ay - by;
  });

  return out;
}
