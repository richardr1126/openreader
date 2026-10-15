import type { ComponentType, SVGProps } from 'react';
import { CpuChipIcon, DatabaseIcon, GlobeIcon, InfoIcon, MicrophoneIcon, PaletteIcon,
  ServerStackIcon, UserIcon, UsersIcon, WrenchIcon } from '@/components/icons/Icons';
import type { InstallProfile } from '@/lib/shared/install-profile';

export type SettingsSectionId = 'api' | 'theme' | 'account' | 'storage' | 'about' | 'users' | 'providers' | 'instance' | 'compute' | 'maintenance';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  shortLabel: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** `admin` sections render only for administrators. */
  group: 'general' | 'admin';
  /** Install profiles that show this section; omitted = every profile. */
  profiles?: readonly InstallProfile[];
};

export type SettingsNavGroup = { label: string; sections: SettingsSection[] };

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'api', label: 'Model & Voice', shortLabel: 'Voice', icon: MicrophoneIcon, group: 'general' },
  { id: 'theme', label: 'Appearance', shortLabel: 'Appearance', icon: PaletteIcon, group: 'general' },
  { id: 'account', label: 'Account', shortLabel: 'Account', icon: UserIcon, group: 'general' },
  { id: 'storage', label: 'Storage', shortLabel: 'Storage', icon: DatabaseIcon, group: 'general' },
  { id: 'about', label: 'About', shortLabel: 'About', icon: InfoIcon, group: 'general' },
  { id: 'users', label: 'Users', shortLabel: 'Users', icon: UsersIcon, group: 'admin', profiles: ['server'] },
  { id: 'providers', label: 'Providers', shortLabel: 'Providers', icon: ServerStackIcon, group: 'admin' },
  { id: 'instance', label: 'Instance', shortLabel: 'Instance', icon: GlobeIcon, group: 'admin' },
  { id: 'compute', label: 'Compute', shortLabel: 'Compute', icon: CpuChipIcon, group: 'admin' },
  { id: 'maintenance', label: 'Maintenance', shortLabel: 'Maintenance', icon: WrenchIcon, group: 'admin' },
];

type NavLayout = ReadonlyArray<{ label: string; ids: readonly SettingsSectionId[] }>;

/**
 * Sidebar grouping per profile. Section ids never change, so links and tests
 * keep working; only grouping and labels differ. On desktop there is one person,
 * so the Admin label means nothing and admin sections join General/Advanced.
 */
const NAV_LAYOUTS: Record<InstallProfile, NavLayout> = {
  server: [
    { label: 'General', ids: ['api', 'theme', 'account', 'storage', 'about'] },
    { label: 'Admin', ids: ['users', 'providers', 'instance', 'compute', 'maintenance'] },
  ],
  desktop: [
    { label: 'General', ids: ['theme', 'api', 'providers', 'storage', 'account'] },
    { label: 'Advanced', ids: ['instance', 'compute', 'maintenance'] },
    { label: 'About', ids: ['about'] },
  ],
};

const DESKTOP_LABELS: Partial<Record<SettingsSectionId, Pick<SettingsSection, 'label' | 'shortLabel'>>> = {
  storage: { label: 'Library and storage', shortLabel: 'Library' },
  account: { label: 'Profile', shortLabel: 'Profile' },
};

export function visibleSettingsSections({ installProfile, isAdmin, enableTtsProvidersTab }: {
  installProfile: InstallProfile;
  isAdmin: boolean;
  enableTtsProvidersTab: boolean;
}): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => {
    if (section.profiles && !section.profiles.includes(installProfile)) return false;
    if (section.id === 'api' && !enableTtsProvidersTab) return false;
    if (section.group === 'admin' && !isAdmin) return false;
    return true;
  }).map((section) => (
    installProfile === 'desktop' && DESKTOP_LABELS[section.id]
      ? { ...section, ...DESKTOP_LABELS[section.id] }
      : section
  ));
}

/** Group visible sections for navigation; empty groups are dropped. */
export function settingsNavGroups(installProfile: InstallProfile, visible: readonly SettingsSection[]): SettingsNavGroup[] {
  const byId = new Map(visible.map((section) => [section.id, section]));
  return NAV_LAYOUTS[installProfile]
    .map(({ label, ids }) => ({
      label,
      sections: ids.flatMap((id) => byId.get(id) ?? []),
    }))
    .filter((group) => group.sections.length > 0);
}

/** Every section id each profile's layout places, for completeness checks. */
export function navLayoutIds(installProfile: InstallProfile): SettingsSectionId[] {
  return NAV_LAYOUTS[installProfile].flatMap((group) => [...group.ids]);
}
