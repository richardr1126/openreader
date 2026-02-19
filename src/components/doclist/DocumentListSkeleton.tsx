'use client';

interface DocumentListSkeletonProps {
  viewMode?: 'list' | 'grid';
}

export function DocumentListSkeleton({ viewMode = 'grid' }: DocumentListSkeletonProps) {
  const placeholders = Array.from({ length: viewMode === 'grid' ? 10 : 6 });

  return (
    <div className="w-full mx-auto animate-pulse" aria-label="Loading documents" aria-busy="true">
      <div className="flex items-center justify-between mb-2">
        <div className="h-6 w-36 rounded bg-offbase" />
        <div className="h-6 w-44 rounded bg-offbase" />
      </div>
      <div className="h-3 w-48 rounded bg-offbase mb-3" />
      <div className="h-9 w-full rounded-lg border-2 border-dashed border-offbase bg-base mb-3" />

      <div
        className={
          viewMode === 'grid'
            ? 'grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5'
            : 'w-full space-y-1'
        }
      >
        {placeholders.map((_, index) => (
          <div
            key={index}
            className={
              viewMode === 'grid'
                ? 'overflow-hidden rounded-md border border-offbase bg-base'
                : 'h-12 rounded-md border border-offbase bg-base'
            }
          >
            {viewMode === 'grid' ? (
              <>
                <div className="aspect-[3/4] w-full bg-offbase" />
                <div className="p-2">
                  <div className="h-3 w-4/5 rounded bg-offbase" />
                  <div className="mt-1 h-2.5 w-1/3 rounded bg-offbase" />
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
