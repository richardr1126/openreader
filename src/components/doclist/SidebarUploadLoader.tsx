export function SidebarUploadLoader({
  totalFiles,
  completedFiles,
  currentFileName,
}: {
  totalFiles: number;
  completedFiles: number;
  phase: 'uploading';
  currentFileName: string | null;
}) {
  const progress = totalFiles > 0
    ? Math.min(100, Math.round((completedFiles / totalFiles) * 100))
    : 0;
  const radius = 7;
  const stroke = 2;
  const size = 18;
  const normalizedRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * normalizedRadius;
  const dashOffset = circumference - (progress / 100) * circumference;

  return (
    <div className="rounded-md border border-line bg-surface-sunken px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] leading-tight">
          <span className="font-medium text-foreground">Uploading</span>
          <span className="shrink-0 tabular-nums text-soft">
            {completedFiles}/{totalFiles}
          </span>
        </div>
        <div
          className="shrink-0 flex items-center gap-1 text-accent"
          aria-label={`Upload progress ${progress}%`}
        >
          <span className="text-[10px] tabular-nums text-soft">{progress}%</span>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dashoffset 200ms ease-standard' }}
            />
          </svg>
        </div>
      </div>
      {currentFileName && (
        <p className="mt-0.5 truncate text-[10px] text-soft" title={currentFileName}>
          {currentFileName}
        </p>
      )}
    </div>
  );
}
