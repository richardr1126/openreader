'use client';

import type { IconSize, ViewMode } from '@/types/documents';
import { iconsGridStyle } from '@/components/doclist/views/iconsGrid';

interface DocumentListSkeletonProps {
  viewMode?: ViewMode;
  iconSize?: IconSize;
}

const ICON_SKELETON_ITEM_COUNT = 12;

function IconsSkeleton({ iconSize }: { iconSize: IconSize }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <div className="grid" style={iconsGridStyle(iconSize, ICON_SKELETON_ITEM_COUNT)}>
        {Array.from({ length: ICON_SKELETON_ITEM_COUNT }).map((_, index) => (
          <div key={index} className="overflow-hidden rounded-md border border-offbase bg-base">
            <div className="aspect-[3/4] w-full bg-offbase" />
            <div className="flex items-center gap-2 px-2 py-2">
              <div className="h-3.5 w-3.5 rounded bg-offbase" />
              <div className="h-2.5 w-4/5 rounded bg-offbase" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-base border-b border-offbase grid grid-cols-[minmax(0,1fr)_72px_88px_120px_28px] sm:grid-cols-[minmax(0,1fr)_88px_96px_140px_32px]">
        <div className="h-8 flex items-center px-2">
          <div className="h-2.5 w-12 rounded bg-offbase" />
        </div>
        <div className="h-8 flex items-center px-2">
          <div className="h-2.5 w-10 rounded bg-offbase" />
        </div>
        <div className="h-8 flex items-center justify-end px-2">
          <div className="h-2.5 w-10 rounded bg-offbase" />
        </div>
        <div className="h-8 flex items-center px-2">
          <div className="h-2.5 w-14 rounded bg-offbase" />
        </div>
        <div />
      </div>
      <div>
        {Array.from({ length: 10 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_72px_88px_120px_28px] sm:grid-cols-[minmax(0,1fr)_88px_96px_140px_32px] items-center border-b border-offbase h-[35px]"
          >
            <div className="px-2 flex items-center gap-2">
              <div className="h-3.5 w-3.5 rounded bg-offbase" />
              <div className="h-2.5 w-2/3 rounded bg-offbase" />
            </div>
            <div className="px-2">
              <div className="h-2.5 w-8 rounded bg-offbase" />
            </div>
            <div className="px-2 flex justify-end">
              <div className="h-2.5 w-12 rounded bg-offbase" />
            </div>
            <div className="px-2">
              <div className="h-2.5 w-16 rounded bg-offbase" />
            </div>
            <div className="px-2 flex justify-center">
              <div className="h-4 w-4 rounded bg-offbase" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ColumnsSkeleton() {
  return (
    <div className="h-full min-h-0 flex overflow-x-auto overflow-y-hidden">
      <div className="w-[260px] shrink-0 h-full bg-base border-r border-offbase overflow-y-auto">
        <div className="sticky top-0 px-3 py-1.5 border-b border-offbase bg-base">
          <div className="h-2.5 w-20 rounded bg-offbase" />
        </div>
        <div className="p-1.5 flex flex-col gap-1">
          {Array.from({ length: 11 }).map((_, rowIndex) => (
            <div key={rowIndex} className="h-7 rounded-md bg-offbase" />
          ))}
        </div>
      </div>
      <div className="flex-1 min-w-[280px] h-full bg-background overflow-y-auto p-4">
        <div className="max-w-[360px] mx-auto">
          <div className="rounded-lg overflow-hidden border border-offbase bg-base">
            <div className="aspect-[3/4] w-full bg-offbase" />
          </div>
          <div className="mt-3 h-3.5 w-4/5 rounded bg-offbase" />
          <div className="mt-2 h-2.5 w-1/3 rounded bg-offbase" />
          <div className="mt-3 flex gap-2">
            <div className="flex-1 h-8 rounded-md bg-offbase" />
            <div className="w-20 h-8 rounded-md bg-offbase" />
          </div>
        </div>
      </div>
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 flex items-center justify-center p-6 bg-background">
        <div className="flex flex-col items-center gap-3 max-w-[420px]">
          <div className="w-[260px] sm:w-[320px] aspect-[3/4] rounded-lg border border-offbase bg-offbase" />
          <div className="h-3 w-40 rounded bg-offbase" />
          <div className="h-2.5 w-28 rounded bg-offbase" />
          <div className="flex gap-2">
            <div className="h-8 w-20 rounded-md bg-offbase" />
            <div className="h-8 w-20 rounded-md bg-offbase" />
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-offbase bg-base">
        <div className="flex gap-2 overflow-x-auto p-2">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="shrink-0 w-[88px] rounded-md overflow-hidden border border-offbase bg-base">
              <div className="aspect-[3/4] bg-offbase" />
              <div className="p-1.5">
                <div className="h-2.5 w-5/6 rounded bg-offbase" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DocumentListSkeleton({
  viewMode = 'icons',
  iconSize = 'md',
}: DocumentListSkeletonProps) {
  let body;
  if (viewMode === 'list') {
    body = <ListSkeleton />;
  } else if (viewMode === 'columns') {
    body = <ColumnsSkeleton />;
  } else if (viewMode === 'gallery') {
    body = <GallerySkeleton />;
  } else {
    body = <IconsSkeleton iconSize={iconSize} />;
  }

  return (
    <div
      className="h-full w-full min-h-0 flex flex-col animate-pulse"
      aria-label="Loading documents"
      aria-busy="true"
    >
      {body}
    </div>
  );
}
