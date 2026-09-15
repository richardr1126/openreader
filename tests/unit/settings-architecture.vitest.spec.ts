import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

const sectionFiles = [
  'AccountSettingsPanel.tsx',
  'AppearanceSettingsPanel.tsx',
  'ProviderSettingsPanel.tsx',
];

describe('settings ownership', () => {
  test('keeps the routed settings composition separate from section behavior', () => {
    const route = source('src/app/(app)/app/settings/page.tsx');
    const page = source('src/components/settings/SettingsPage.tsx');
    const library = source('src/components/HomeContent.tsx');

    expect(route).toContain("from '@/components/settings/SettingsPage'");
    expect(library).toContain('href="/app/settings"');
    expect(library).not.toContain('SettingsModal');
    for (const sectionFile of sectionFiles) {
      expect(page).toContain(`from './${sectionFile.replace('.tsx', '')}'`);
    }
    expect(page).not.toContain("fetch('/api/");
    expect(page).not.toContain('new EventSource');
    expect(page).toContain('Close settings');
    expect(page).toContain('SidebarNavItem');
    expect(page).toContain('>General</SidebarNavGroup>');
    expect(page).toContain('>Admin</SidebarNavGroup>');
    expect(page).toContain('<AdminEmailPanel');
    expect(page).not.toContain('AdminSettingsPanel');
    expect(page).toContain('useSearchParams');
    expect(page).toContain('router.replace(`/app/settings?section=${section}`');
    expect(page.split('\n').length).toBeLessThan(320);
  });

  test('keeps changelog as a standalone modal shared by onboarding and settings', () => {
    const modal = source('src/components/settings/ChangelogModal.tsx');
    const changelog = source('src/components/settings/SettingsChangelogPanel.tsx');
    const onboarding = source('src/contexts/OnboardingFlowContext.tsx');

    expect(modal).toContain('panelTestId="changelog-modal"');
    expect(modal).toContain('<SettingsChangelogPanel');
    expect(changelog).toContain('Close changelog');
    expect(onboarding).toContain('<ChangelogModal');
    expect(onboarding).toContain('openChangelog');
    expect(onboarding).toContain('handleBlockingModalAfterLeave');
    expect(onboarding).toContain('currentUserIdRef.current !== userId');
    expect(onboarding).toContain('claimModalOwnerId !== userId');
    expect(onboarding).toContain("activeBlockingModal === 'claim' && claimModalOwnerId === userId");
    expect(onboarding).toContain('claimDismissedUsersRef.current.add(claimModalOwnerId)');
    expect(onboarding).not.toContain('openreader:privacyAccepted');
  });

  test('keeps account navigation separate from signing out', () => {
    const userMenu = source('src/components/auth/UserMenu.tsx');
    const route = source('src/app/(app)/app/settings/page.tsx');

    expect(userMenu).toContain('href="/app/settings?section=account"');
    expect(userMenu).toContain('aria-label="Open account settings"');
    expect(userMenu).toContain('aria-label="Sign out"');
    expect(userMenu).not.toContain('Disconnect account');
    expect(route).toContain('initialSection={section}');
  });

  test('prevents settings sections from importing one another', () => {
    for (const sectionFile of sectionFiles) {
      const sectionSource = source(`src/components/settings/${sectionFile}`);
      for (const otherSection of sectionFiles.filter((candidate) => candidate !== sectionFile)) {
        expect(sectionSource, `${sectionFile} imports ${otherSection}`).not.toContain(
          `./${otherSection.replace('.tsx', '')}`,
        );
      }
    }
  });

  test('gives long-running import and export work explicit cleanup owners', () => {
    const libraryImport = source('src/components/documents/useLibraryImport.ts');
    const uploadDialog = source('src/components/documents/UploadMenuDialog.tsx');
    const accountExport = source('src/components/settings/useAccountExport.ts');

    expect(libraryImport).toContain('abortRef.current?.abort()');
    expect(libraryImport).toContain('useEffect(() => cancel, [cancel])');
    expect(uploadDialog).toContain("id: 'library'");
    expect(uploadDialog).toContain('Browse server library');
    expect(accountExport).toContain('sourceRef.current?.close()');
    expect(accountExport).toContain('useEffect(() => closeSource, [closeSource])');
  });

  test('shows TTS generation usage without replacing cached playback controls', () => {
    const account = source('src/components/settings/AccountSettingsPanel.tsx');
    const readers = [
      source('src/app/(app)/epub/[id]/page.tsx'),
      source('src/app/(app)/pdf/[id]/page.tsx'),
      source('src/app/(app)/html/[id]/page.tsx'),
    ];

    expect(account).toContain('Daily TTS generation usage');
    expect(account).toContain('Replaying cached audio is always free.');
    expect(account).toContain('New generation pauses at the next uncached segment.');
    for (const reader of readers) {
      expect(reader).toContain('<TTSPlayer');
      expect(reader).not.toContain('isAtLimit');
      expect(reader).not.toContain('RateLimitPauseButton');
    }
  });
});
