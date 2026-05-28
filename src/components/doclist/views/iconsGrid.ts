import type { CSSProperties } from 'react';
import type { IconSize } from '@/types/documents';

const TILE_WIDTH_PX: Record<IconSize, number> = {
  sm: 112,
  md: 136,
  lg: 162,
  xl: 192,
};

const SMALL_GRID_ITEM_COUNT = 3;
const GRID_GAP_PX = 12;

function responsiveGridTemplate(iconSize: IconSize, itemCount: number): string {
  const width = TILE_WIDTH_PX[iconSize];
  if (itemCount <= SMALL_GRID_ITEM_COUNT) {
    return `repeat(auto-fill, minmax(${width}px, ${width}px))`;
  }
  return `repeat(auto-fit, minmax(${width}px, 1fr))`;
}

export function iconsGridStyle(iconSize: IconSize, itemCount: number): CSSProperties {
  return {
    gridTemplateColumns: responsiveGridTemplate(iconSize, itemCount),
    gap: `${GRID_GAP_PX}px`,
    justifyContent: itemCount <= SMALL_GRID_ITEM_COUNT ? 'start' : undefined,
  };
}
