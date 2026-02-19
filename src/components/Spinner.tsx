// Loading spinner component
interface SpinnerProps {
  className?: string;
}

export function LoadingSpinner({ className }: SpinnerProps = {}) {
  return (
    <div className={className || "absolute inset-0 flex items-center justify-center"}>
      <div className="animate-spin h-4 w-4 border-2 border-foreground border-t-transparent rounded-full" />
    </div>
  );
}