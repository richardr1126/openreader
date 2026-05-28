// Loading spinner component
interface SpinnerProps {
  className?: string;
}

export function LoadingSpinner({ className }: SpinnerProps = {}) {
  if (className) {
    return (
      <div
        className={`animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
    </div>
  );
}