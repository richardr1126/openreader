'use client';

import { Fragment, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { DocumentIcon, InfoIcon } from '@/components/icons/Icons';
import { AdminEmailPanel } from '@/components/admin/AdminEmailPanel';
import { AdminGutendexPanel } from '@/components/admin/AdminGutendexPanel';
import { AdminFeaturesPanel } from '@/components/admin/AdminFeaturesPanel';
import { AdminProvidersPanel } from '@/components/admin/AdminProvidersPanel';
import { AdminSystemPanel } from '@/components/admin/AdminSystemPanel';
import { AdminTasksPanel } from '@/components/admin/AdminTasksPanel';
import { AdminUsersPanel } from '@/components/admin/AdminUsersPanel';
import { Sidebar, SidebarNav, SidebarNavGroup, SidebarNavItem, Toolbar } from '@/components/ui';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { useOnboardingFlow } from '@/contexts/OnboardingFlowContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { normalizeVersion } from '@/lib/shared/changelog';
import { AboutSettingsPanel } from './AboutSettingsPanel';
import { AccountSettingsPanel } from './AccountSettingsPanel';
import { StorageSettingsPanel } from './StorageSettingsPanel';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';
import { settingsNavGroups, visibleSettingsSections, type SettingsSectionId } from './settings-sections';

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

export function SettingsPage({ initialSection }: { initialSection?: SettingsSectionId }) {
  const runtimeConfig = useRuntimeConfig();
  const { openChangelog } = useOnboardingFlow();
  const { data: session } = useAuthSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = Boolean(
    (session?.user as unknown as { isAdmin?: boolean } | undefined)?.isAdmin,
  );
  const { installProfile, enableTtsProvidersTab } = runtimeConfig;
  const navGroups = useMemo(
    () => settingsNavGroups(installProfile, visibleSettingsSections({ installProfile, isAdmin, enableTtsProvidersTab })),
    [enableTtsProvidersTab, installProfile, isAdmin],
  );
  const orderedSections = navGroups.flatMap((group) => group.sections);
  const requestedSection = searchParams.get('section') ?? initialSection;
  const currentSection = orderedSections.find((section) => section.id === requestedSection)
    ?? orderedSections[0];
  const activeSection = currentSection?.id ?? 'theme';
  const displayVersion = normalizeVersion(runtimeConfig.appVersion || '');
  const selectSection = (section: SettingsSectionId) => {
    router.replace(`/app/settings?section=${section}`, { scroll: false });
  };

  return (
    <div data-testid="settings-page" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface-sunken">
      <Toolbar className="shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h1 className="truncate text-sm font-bold tracking-tight text-foreground">Settings</h1>
        </div>
        <div className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={openChangelog}
          aria-label="Changelog"
          className="h-7 rounded-md px-2 text-xs font-medium text-soft transition-colors hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
        >
          Changelog
        </button>
        <CloseSettingsLink />
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        <Sidebar className="hidden h-full w-[220px] shrink-0 flex-col rounded-none border-y-0 border-l-0 border-r border-line-soft bg-surface shadow-none md:flex">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav className="p-2">
              {navGroups.map((group, index) => (
                <Fragment key={group.label}>
                  <SidebarNavGroup isFirst={index === 0}>{group.label}</SidebarNavGroup>
                  {group.sections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <SidebarNavItem
                        key={section.id}
                        compact
                        active={activeSection === section.id}
                        onClick={() => selectSection(section.id)}
                        aria-label={section.label}
                        icon={<Icon className="h-3.5 w-3.5" />}
                        label={section.label}
                      />
                    );
                  })}
                </Fragment>
              ))}
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
              {/* The notice describes a hosted instance; desktop has no operator. */}
              {installProfile === 'server' ? (
                <SidebarNavItem
                  compact
                  onClick={() => showPrivacyModal()}
                  aria-label="Privacy"
                  icon={<DocumentIcon className="h-3.5 w-3.5" />}
                  label="Privacy"
                />
              ) : null}
            </SidebarNav>
          </div>
        </Sidebar>

        <div className="flex min-w-0 flex-1 flex-col">
          <nav
            aria-label="Settings sections"
            className="shrink-0 overflow-x-auto border-b border-line-soft bg-surface px-2 py-1.5 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex min-w-max gap-1">
              {navGroups.map((group, index) => [
                <span key={group.label} className={`${index === 0 ? '' : 'ml-2 '}flex h-8 items-center px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-faint`}>{group.label}</span>,
                ...group.sections.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => selectSection(section.id)}
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
                }),
              ])}
            </div>
          </nav>

          <section id="main-content" tabIndex={-1} aria-label={currentSection?.label ?? 'Settings'} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
            {currentSection ? (
              <div className={`mx-auto w-full p-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-5 lg:p-8 ${currentSection.group === 'admin' ? 'max-w-6xl' : 'max-w-4xl'}`}>
                <h2 className="mb-4 text-lg font-semibold tracking-tight text-foreground sm:mb-5">
                  {currentSection.label}
                </h2>

                <div>
                  {runtimeConfig.enableTtsProvidersTab && activeSection === 'api' ? <ProviderSettingsPanel active /> : null}
                  {activeSection === 'theme' ? (
                    <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
                      <AppearanceSettingsPanel />
                    </div>
                  ) : null}
                  {activeSection === 'account' ? <AccountSettingsPanel /> : null}
                  {activeSection === 'storage' ? <StorageSettingsPanel /> : null}
                  {activeSection === 'about' ? <AboutSettingsPanel /> : null}
                  {isAdmin && activeSection === 'users' ? <AdminUsersPanel /> : null}
                  {isAdmin && activeSection === 'providers' ? <AdminProvidersPanel /> : null}
                  {isAdmin && activeSection === 'instance' ? (
                    <div className="space-y-5">
                      <AdminFeaturesPanel scope="instance" />
                      {installProfile === 'server' ? <AdminEmailPanel /> : null}
                      <AdminGutendexPanel />
                    </div>
                  ) : null}
                  {isAdmin && activeSection === 'compute' ? <AdminFeaturesPanel scope="compute" /> : null}
                  {isAdmin && activeSection === 'maintenance' ? (
                    <div className="space-y-5">
                      <AdminSystemPanel />
                      <AdminTasksPanel />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
