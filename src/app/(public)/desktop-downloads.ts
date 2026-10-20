import type { DesktopInstaller } from '@/lib/shared/changelog';

export type DesktopPlatform = DesktopInstaller['platform'];
export type DesktopArch = DesktopInstaller['arch'];

export const PLATFORMS: Record<
  DesktopPlatform,
  { name: string; requirement: string; arch: Record<DesktopArch, string>; preferred: string }
> = {
  mac: {
    name: 'macOS',
    requirement: 'macOS 12 or later',
    arch: { arm64: 'Apple silicon', x64: 'Intel' },
    preferred: '.dmg',
  },
  windows: {
    name: 'Windows',
    requirement: 'Windows 10 or later',
    arch: { x64: 'x64', arm64: 'Arm' },
    preferred: '.exe',
  },
  linux: {
    name: 'Linux',
    requirement: 'AppImage for most distributions, .deb for Debian and Ubuntu',
    arch: { x64: 'x86-64', arm64: 'ARM64' },
    preferred: 'AppImage',
  },
};

export const PLATFORM_ORDER: DesktopPlatform[] = ['mac', 'windows', 'linux'];

/** Decimal units, as the App Store and most download pages report them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * The one installer to offer first, preferring the platform's usual format. A known
 * architecture is a strict filter: no build for it (an Intel Mac) offers nothing.
 */
export function pickInstaller(
  installers: DesktopInstaller[],
  platform: DesktopPlatform,
  arch: DesktopArch | null,
): DesktopInstaller | null {
  const matching = installers.filter((i) => i.platform === platform && (!arch || i.arch === arch));
  const rank = (i: DesktopInstaller) => (i.format === PLATFORMS[platform].preferred ? 0 : 1);
  return matching.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export function installerLabel(installer: DesktopInstaller): string {
  return `${PLATFORMS[installer.platform].arch[installer.arch]} · ${installer.format}`;
}

export function formatReleaseDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
