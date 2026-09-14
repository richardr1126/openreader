'use client';

import { ModalFrame, ModalTitle } from '@/components/ui';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { SettingsChangelogPanel } from './SettingsChangelogPanel';

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runtimeConfig = useRuntimeConfig();

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      size="xl"
      panelTestId="changelog-modal"
      className="z-[90]"
    >
      <ModalTitle className="sr-only">Changelog</ModalTitle>
      <SettingsChangelogPanel
        appVersion={runtimeConfig.appVersion}
        manifestUrl={runtimeConfig.changelogFeedUrl}
        onClose={onClose}
      />
    </ModalFrame>
  );
}
