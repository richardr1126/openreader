import { useEffect } from 'react';
import toast from 'react-hot-toast';

export function DocumentSkeleton() {
  useEffect(() => {
    const timer = setTimeout(() => {
      toast('There might be an issue with the file import. Please try again.', {
        icon: '⚠️',
        duration: 5000,
      });
    }, 3000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] w-full">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin"></div>
      </div>
    </div>
  );
}
