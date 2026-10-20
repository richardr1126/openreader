import { IconButton, Tooltip } from '@/components/ui';

/** A reader's page scale, or its column width when the text reflows. */
export interface ZoomSetting {
  value: number;
  onIncrease: () => void;
  onDecrease: () => void;
  min: number;
  max: number;
}

export function ZoomControl({ value, onIncrease, onDecrease, min, max }: ZoomSetting) {
  return (
    <div role="group" className="flex items-center gap-1 select-none" aria-label="Zoom controls">
      <Tooltip label="Zoom out">
        <IconButton
          onClick={onDecrease}
          disabled={value <= min}
          size="sm"
          className="h-6 w-6 text-sm leading-none"
          aria-label="Zoom out"
        >
          −
        </IconButton>
      </Tooltip>
      <span className="text-xs tabular-nums w-10 text-center text-soft">{value}%</span>
      <Tooltip label="Zoom in">
        <IconButton
          onClick={onIncrease}
          disabled={value >= max}
          size="sm"
          className="h-6 w-6 text-sm leading-none"
          aria-label="Zoom in"
        >
          ＋
        </IconButton>
      </Tooltip>
    </div>
  );
}
