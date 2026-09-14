import type { Metadata } from 'next';
import { SettingsPage, type SettingsSectionId } from '@/components/settings/SettingsPage';

export const metadata: Metadata = {
  title: 'Settings',
};

const SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  'api', 'theme', 'account', 'providers', 'instance', 'compute', 'email', 'maintenance',
]);

export default async function SettingsRoute({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const requestedSection = (await searchParams).section;
  const section = typeof requestedSection === 'string' && SETTINGS_SECTIONS.has(requestedSection as SettingsSectionId)
    ? requestedSection as SettingsSectionId
    : undefined;
  return <SettingsPage initialSection={section} />;
}
