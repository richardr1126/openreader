import type { Metadata } from 'next';
import { SettingsPage } from '@/components/settings/SettingsPage';

export const metadata: Metadata = {
  title: 'Settings',
};

const SETTINGS_SECTIONS = new Set(['api', 'theme', 'account', 'admin'] as const);

type SettingsSection = 'api' | 'theme' | 'account' | 'admin';

export default async function SettingsRoute({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const requestedSection = (await searchParams).section;
  const section = typeof requestedSection === 'string' && SETTINGS_SECTIONS.has(requestedSection as SettingsSection)
    ? requestedSection as SettingsSection
    : undefined;
  return <SettingsPage initialSection={section} />;
}
