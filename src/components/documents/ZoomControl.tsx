import { buttonClass } from '@/components/ui/buttonPrimitives';

export function ZoomControl({
  value,
  onIncrease,
  onDecrease,
  min = 50,
  max = 300,
}: {
  value: number;
  onIncrease: () => void;
  onDecrease: () => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1 select-none" aria-label="Zoom controls">
      <button
        type="button"
        onClick={onDecrease}
        disabled={value <= min}
        className={buttonClass({
          variant: 'ghost',
          size: 'icon',
          className: 'h-6 w-6 text-sm leading-none',
        })}
        aria-label="Zoom out"
      >
        −
      </button>
      <span className="text-xs tabular-nums w-12 text-center text-soft">{value}%</span>
      <button
        type="button"
        onClick={onIncrease}
        disabled={value >= max}
        className={buttonClass({
          variant: 'ghost',
          size: 'icon',
          className: 'h-6 w-6 text-sm leading-none',
        })}
        aria-label="Zoom in"
      >
        ＋
      </button>
    </div>
  );
}
