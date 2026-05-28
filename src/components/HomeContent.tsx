'use client';

import { DocumentList } from '@/components/doclist/DocumentList';
import { SettingsModal } from '@/components/SettingsModal';
import { UserMenu } from '@/components/auth/UserMenu';

const Brand = () => (
  <div className="flex items-center gap-2 min-w-0">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/icon.svg" alt="" className="w-5 h-5 shrink-0" aria-hidden="true" />
    <h1 className="hidden sm:block text-xs sm:text-sm font-bold truncate text-foreground tracking-tight">
      OpenReader
    </h1>
  </div>
);

const AppActions = () => (
  <div className="flex flex-col gap-0.5 w-full">
    <SettingsModal
      triggerLabel="Settings"
      className="w-full justify-start gap-2 px-2 py-1 text-[12px] border-transparent hover:border-accent"
    />
    <UserMenu variant="sidebar" />
  </div>
);

export function HomeContent() {
  return (
    <div className="w-full h-full">
      <DocumentList brand={<Brand />} appActions={<AppActions />} />
    </div>
  );
}
