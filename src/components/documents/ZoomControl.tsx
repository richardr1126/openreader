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
        className="px-1 text-sm leading-none text-foreground hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed transform transition-transform duration-200 ease-in-out hover:scale-[1.09]"
        aria-label="Zoom out"
      >
        −
      </button>
      <span className="text-xs tabular-nums w-12 text-center text-muted">{value}%</span>
      <button
        type="button"
        onClick={onIncrease}
        disabled={value >= max}
        className="px-1 text-sm leading-none text-foreground hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed transform transition-transform duration-200 ease-in-out hover:scale-[1.09]"
        aria-label="Zoom in"
      >
        ＋
      </button>
    </div>
  );
}
