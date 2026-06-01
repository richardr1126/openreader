'use client';

import { useState } from 'react';
import { DocumentList } from '@/components/doclist/DocumentList';
import { SettingsModal, SettingsTrigger } from '@/components/SettingsModal';
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

export function HomeContent() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const appActions = (
    <div className="flex flex-col gap-0.5 w-full">
      <SettingsTrigger
        variant="sidebar"
        triggerLabel="Settings"
        onOpen={() => setSettingsOpen(true)}
      />
      <UserMenu variant="sidebar" />
    </div>
  );

  return (
    <div className="w-full h-full">
      <DocumentList brand={<Brand />} appActions={appActions} />
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
