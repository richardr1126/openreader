'use client';

import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react';
import {
  DocumentIcon,
  KeyIcon,
  PaletteIcon,
  SettingsIcon,
  UserIcon,
} from '@/components/icons/Icons';
import { Button, SidebarDialog, SidebarNavItem } from '@/components/ui';
import { useOnboardingFlow } from '@/contexts/OnboardingFlowContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { normalizeVersion } from '@/lib/shared/changelog';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { AccountSettingsPanel } from './AccountSettingsPanel';
import { AdminSettingsPanel } from './AdminSettingsPanel';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { DocumentSettingsPanel } from './DocumentSettingsPanel';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';
import { SettingsChangelogPanel } from './SettingsChangelogPanel';

type SectionId = 'api' | 'theme' | 'docs' | 'account' | 'admin';

type SidebarSection = {
  id: SectionId;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  authOnly?: boolean;
  adminOnly?: boolean;
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: 'api', label: 'TTS Provider', icon: KeyIcon },
  { id: 'theme', label: 'Appearance', icon: PaletteIcon },
  { id: 'docs', label: 'Documents', icon: DocumentIcon },
  { id: 'account', label: 'Account', icon: UserIcon, authOnly: true },
  { id: 'admin', label: 'Admin', icon: SettingsIcon, authOnly: true, adminOnly: true },
];

export function SettingsTrigger({
  className = '',
  triggerLabel,
  variant = 'button',
  onOpen,
}: {
  className?: string;
  triggerLabel?: string;
  variant?: 'button' | 'sidebar';
  onOpen: () => void;
}) {
  if (variant === 'sidebar') {
    return (
      <SidebarNavItem
        compact
        onClick={onOpen}
        className={className}
        aria-label="Settings"
        icon={<SettingsIcon className="w-3.5 h-3.5" />}
        label={triggerLabel ?? 'Settings'}
      />
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onOpen}
      className={className}
      aria-label="Settings"
      tabIndex={0}
    >
      <SettingsIcon className="w-4 h-4 transition-transform duration-base ease-standard hover:rotate-45" />
      {triggerLabel && <span className="ml-2">{triggerLabel}</span>}
    </Button>
  );
}

export function SettingsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const runtimeConfig = useRuntimeConfig();
  const { data: session } = useAuthSession();
  const { changelogOpenSignal } = useOnboardingFlow();
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>(
    runtimeConfig.enableTtsProvidersTab ? 'api' : 'theme',
  );
  const isAdmin = Boolean(
    (session?.user as unknown as { isAdmin?: boolean } | undefined)?.isAdmin,
  );
  const visibleSections = useMemo(
    () => SIDEBAR_SECTIONS.filter((section) => {
      if (section.id === 'api' && !runtimeConfig.enableTtsProvidersTab) return false;
      if (section.adminOnly && !isAdmin) return false;
      return true;
    }),
    [isAdmin, runtimeConfig.enableTtsProvidersTab],
  );
  const displayVersion = normalizeVersion(runtimeConfig.appVersion || '');

  useEffect(() => {
    if (changelogOpenSignal <= 0) return;
    onOpenChange(true);
    setIsChangelogOpen(true);
  }, [changelogOpenSignal, onOpenChange]);

  useEffect(() => {
    if (visibleSections.some((section) => section.id === activeSection)) return;
    setActiveSection(visibleSections[0]?.id ?? 'theme');
  }, [activeSection, visibleSections]);

  const close = () => {
    setIsChangelogOpen(false);
    onOpenChange(false);
  };

  return (
    <SidebarDialog
      open={open}
      onClose={close}
      size="xl"
      panelTestId="settings-modal"
      modalClassName={isChangelogOpen ? 'z-[90]' : 'z-50'}
      headerTitle={
        <div className="flex items-baseline gap-4">
          <span>Settings</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsChangelogOpen(true)}
            className="text-sm font-medium leading-6 text-soft hover:text-accent transition-colors"
          >
            {displayVersion ? `v${displayVersion} · Changelog` : 'Changelog'}
          </Button>
        </div>
      }
      headerRight={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => showPrivacyModal()}
          className="text-sm font-medium text-soft hover:text-accent transition-colors"
        >
          Privacy
        </Button>
      }
      showCloseButton={false}
      sections={visibleSections}
      activeSectionId={activeSection}
      onSectionChange={setActiveSection}
      className="h-[490px]"
      contentClassName={
        activeSection === 'admin'
          ? 'bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]'
          : ''
      }
      customContent={
        isChangelogOpen ? (
          <SettingsChangelogPanel
            appVersion={runtimeConfig.appVersion}
            manifestUrl={runtimeConfig.changelogFeedUrl}
            onClose={() => setIsChangelogOpen(false)}
          />
        ) : undefined
      }
    >
      {runtimeConfig.enableTtsProvidersTab && (
        <div hidden={activeSection !== 'api'}>
          <ProviderSettingsPanel modalOpen={open} onSaved={close} />
        </div>
      )}
      <div hidden={activeSection !== 'theme'}>
        <AppearanceSettingsPanel />
      </div>
      <div hidden={activeSection !== 'docs'}>
        <DocumentSettingsPanel />
      </div>
      <div hidden={activeSection !== 'account'}>
        <AccountSettingsPanel />
      </div>
      {isAdmin && (
        <div hidden={activeSection !== 'admin'}>
          <AdminSettingsPanel />
        </div>
      )}
    </SidebarDialog>
  );
}
