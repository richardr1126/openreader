interface ProgressCardProps {
  progress: number;
  estimatedTimeRemaining?: string;
  onCancel: (e?: React.MouseEvent) => void;
  operationType?: 'sync' | 'load' | 'library' | 'audiobook';
  cancelText?: string;
  currentChapter?: string;
  completedChapters?: number;
  statusMessage?: string;
}

export function ProgressCard({ 
  progress, 
  estimatedTimeRemaining, 
  onCancel, 
  operationType, 
  cancelText = 'Cancel',
  currentChapter,
  completedChapters,
  statusMessage
}: ProgressCardProps) {
  const getOperationLabel = () => {
    if (operationType === 'sync') return 'Saving to Server';
    if (operationType === 'load') return 'Loading from Server';
    if (operationType === 'library') return 'Importing Library';
    if (operationType === 'audiobook') return 'Generating Audiobook';
    return null;
  };

  const operationLabel = getOperationLabel();

  return (
    <div className="bg-offbase rounded-lg p-3 space-y-2">
      {/* Header with operation type and cancel button */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          {operationLabel && (
            <div className="text-accent font-semibold text-xs uppercase tracking-wide">
              {operationLabel}
            </div>
          )}
          {statusMessage && (
            <div className="text-sm font-medium text-foreground truncate" title={statusMessage}>
              {statusMessage}
            </div>
          )}
          {currentChapter && (
            <div className="text-sm font-medium text-foreground truncate" title={currentChapter}>
              {currentChapter}
            </div>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:text-accent hover:bg-background/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
          onClick={(e) => onCancel(e)}
        >
          <span>{cancelText}</span>
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-background rounded-full overflow-hidden h-1.5">
        <div
          className="h-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-2 text-xs text-muted">
        {completedChapters !== undefined && (
          <>
            <span className="font-medium">{completedChapters} chapters</span>
            <span>•</span>
          </>
        )}
        <span className="font-medium">{Math.round(progress)}%</span>
        {estimatedTimeRemaining && (
          <>
            <span>•</span>
            <span>{estimatedTimeRemaining}</span>
          </>
        )}
      </div>
    </div>
  );
}
