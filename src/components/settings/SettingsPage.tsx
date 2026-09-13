'use client';

import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react';
import Link from 'next/link';
import {
  DocumentIcon,
  InfoIcon,
  KeyIcon,
  PaletteIcon,
  SettingsIcon,
  UserIcon,
} from '@/components/icons/Icons';
import { Sidebar, SidebarNav, SidebarNavGroup, SidebarNavItem } from '@/components/ui';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { useOnboardingFlow } from '@/contexts/OnboardingFlowContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { normalizeVersion } from '@/lib/shared/changelog';
import { AccountSettingsPanel } from './AccountSettingsPanel';
import { AdminSettingsPanel } from './AdminSettingsPanel';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';

type SectionId = 'api' | 'theme' | 'account' | 'admin';

type SettingsSection = {
  id: SectionId;
  label: string;
  shortLabel: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  adminOnly?: boolean;
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'api',
    label: 'TTS Provider',
    shortLabel: 'Provider',
    description: 'Choose the service and model OpenReader uses to narrate.',
    icon: KeyIcon,
  },
  {
    id: 'theme',
    label: 'Appearance',
    shortLabel: 'Appearance',
    description: 'Choose a theme or build a custom reading palette.',
    icon: PaletteIcon,
  },
  {
    id: 'account',
    label: 'Account',
    shortLabel: 'Account',
    description: 'Review your session, usage, exports, and account controls.',
    icon: UserIcon,
  },
  {
    id: 'admin',
    label: 'Admin',
    shortLabel: 'Admin',
    description: 'Manage shared providers, instance policy, compute, and maintenance.',
    icon: SettingsIcon,
    adminOnly: true,
  },
];

function CloseSettingsLink() {
  return (
    <Link
      href="/app"
      aria-label="Close settings"
      title="Close settings"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-soft transition-colors duration-base hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </Link>
  );
}

export function SettingsPage({ initialSection }: { initialSection?: SectionId }) {
  const runtimeConfig = useRuntimeConfig();
  const { openChangelog } = useOnboardingFlow();
  const { data: session } = useAuthSession();
  const isAdmin = Boolean(
    (session?.user as unknown as { isAdmin?: boolean } | undefined)?.isAdmin,
  );
  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => {
      if (section.id === 'api' && !runtimeConfig.enableTtsProvidersTab) return false;
      if (section.adminOnly && !isAdmin) return false;
      return true;
    }),
    [isAdmin, runtimeConfig.enableTtsProvidersTab],
  );
  const [activeSection, setActiveSection] = useState<SectionId>(
    initialSection ?? (runtimeConfig.enableTtsProvidersTab ? 'api' : 'theme'),
  );

  useEffect(() => {
    if (visibleSections.some((section) => section.id === activeSection)) return;
    setActiveSection(visibleSections[0]?.id ?? 'theme');
  }, [activeSection, visibleSections]);

  const currentSection = visibleSections.find((section) => section.id === activeSection)
    ?? visibleSections[0];
  const displayVersion = normalizeVersion(runtimeConfig.appVersion || '');

  return (
    <div data-testid="settings-page" className="flex h-full min-h-0 w-full bg-surface-sunken">
      <Sidebar className="hidden h-full w-[220px] shrink-0 flex-col rounded-none border-y-0 border-l-0 border-r border-line-soft bg-surface shadow-none md:flex">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line-soft px-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-5 w-5 shrink-0" aria-hidden="true" />
            <h1 className="truncate text-sm font-bold tracking-tight text-foreground">Settings</h1>
          </div>
          <CloseSettingsLink />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarNav className="p-2">
            <SidebarNavGroup isFirst>Settings</SidebarNavGroup>
            {visibleSections.map((section) => {
              const Icon = section.icon;
              return (
                <SidebarNavItem
                  key={section.id}
                  compact
                  active={activeSection === section.id}
                  onClick={() => setActiveSection(section.id)}
                  aria-label={section.label}
                  icon={<Icon className="h-3.5 w-3.5" />}
                  label={section.label}
                />
              );
            })}
          </SidebarNav>
        </div>

        <div className="shrink-0 border-t border-line-soft px-2 pb-2 pt-2">
          <SidebarNav>
            <SidebarNavItem
              compact
              onClick={openChangelog}
              aria-label="Changelog"
              icon={<InfoIcon className="h-3.5 w-3.5" />}
              label={displayVersion ? `Changelog · v${displayVersion}` : 'Changelog'}
            />
            <SidebarNavItem
              compact
              onClick={() => showPrivacyModal()}
              aria-label="Privacy"
              icon={<DocumentIcon className="h-3.5 w-3.5" />}
              label="Privacy"
            />
          </SidebarNav>
        </div>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line-soft bg-surface px-2.5 md:hidden">
          <div className="flex min-w-0 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-5 w-5 shrink-0" aria-hidden="true" />
            <h1 className="truncate text-sm font-bold tracking-tight text-foreground">Settings</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={openChangelog}
              aria-label="Changelog"
              className="h-7 rounded-md px-2 text-xs font-medium text-soft transition-colors hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Changelog
            </button>
            <CloseSettingsLink />
          </div>
        </div>

        <nav
          aria-label="Settings sections"
          className="shrink-0 overflow-x-auto border-b border-line-soft bg-surface px-2 py-1.5 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex min-w-max gap-1">
            {visibleSections.map((section) => {
              const Icon = section.icon;
              const active = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  aria-label={section.label}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    active
                      ? 'border-accent-line bg-surface-sunken text-accent'
                      : 'border-transparent text-foreground hover:bg-accent-wash hover:text-accent'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {section.shortLabel}
                </button>
              );
            })}
          </div>
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          {currentSection ? (
            <div className={`mx-auto w-full p-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-5 lg:p-8 ${activeSection === 'admin' ? 'max-w-6xl' : 'max-w-4xl'}`}>
              <div className="mb-4 sm:mb-5">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  {currentSection.label}
                </h2>
                <p className="mt-0.5 text-xs leading-5 text-soft sm:text-sm">
                  {currentSection.description}
                </p>
              </div>

              <div role="tabpanel" aria-label={currentSection.label}>
                {runtimeConfig.enableTtsProvidersTab && activeSection === 'api' ? (
                  <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
                    <ProviderSettingsPanel active />
                  </div>
                ) : null}
                {activeSection === 'theme' ? (
                  <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
                    <AppearanceSettingsPanel />
                  </div>
                ) : null}
                {activeSection === 'account' ? <AccountSettingsPanel /> : null}
                {isAdmin && activeSection === 'admin' ? <AdminSettingsPanel /> : null}
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
