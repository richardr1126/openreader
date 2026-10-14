import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The icon module is JSX, which this node test project does not transform.
vi.mock('@/components/icons/Icons', () => {
  const icon = () => null;
  return {
    AudioWaveIcon: icon, ClockIcon: icon, InfoIcon: icon, KeyIcon: icon,
    PaletteIcon: icon, SettingsIcon: icon, SpeedometerIcon: icon, UserIcon: icon,
  };
});
import {
  navLayoutIds,
  SETTINGS_SECTIONS,
  settingsNavGroups,
  visibleSettingsSections,
} from '@/components/settings/settings-sections';
import { findInstallProfileViolations } from '../../scripts/check-install-profile.mjs';

function groups(installProfile: 'server' | 'desktop', isAdmin = true, enableTtsProvidersTab = true) {
  const visible = visibleSettingsSections({ installProfile, isAdmin, enableTtsProvidersTab });
  return settingsNavGroups(installProfile, visible).map((group) => ({
    label: group.label,
    sections: group.sections.map((section) => `${section.id}:${section.label}`),
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installProfile derivation', () => {
  test('is desktop exactly when a launch token is configured', async () => {
    const { resolveInstallProfile } = await import('@/lib/server/runtime-config');
    vi.stubEnv('DESKTOP_LAUNCH_TOKEN', '');
    expect(resolveInstallProfile()).toBe('server');
    vi.stubEnv('DESKTOP_LAUNCH_TOKEN', '   ');
    expect(resolveInstallProfile()).toBe('server');
    vi.stubEnv('DESKTOP_LAUNCH_TOKEN', 'a'.repeat(43));
    expect(resolveInstallProfile()).toBe('desktop');
  });

  test('is not an admin-editable runtime setting', async () => {
    const { RUNTIME_CONFIG_SCHEMA } = await import('@/lib/server/admin/settings');
    expect(Object.keys(RUNTIME_CONFIG_SCHEMA)).not.toContain('installProfile');
  });
});

describe('settings sections by install profile', () => {
  test('server keeps the General and Admin grouping', () => {
    expect(groups('server')).toEqual([
      { label: 'General', sections: ['api:TTS Provider', 'theme:Appearance', 'account:Account', 'storage:Storage', 'about:About'] },
      { label: 'Admin', sections: ['users:Users', 'providers:Providers', 'instance:Instance', 'compute:Compute', 'maintenance:Maintenance'] },
    ]);
    expect(groups('server', false)).toEqual([
      { label: 'General', sections: ['api:TTS Provider', 'theme:Appearance', 'account:Account', 'storage:Storage', 'about:About'] },
    ]);
  });

  test('desktop hides Users and regroups the rest under General, Advanced and About', () => {
    expect(groups('desktop')).toEqual([
      { label: 'General', sections: ['theme:Appearance', 'api:Voice', 'providers:Voice sources', 'storage:Library and storage', 'account:Profile'] },
      { label: 'Advanced', sections: ['instance:Instance', 'compute:Compute', 'maintenance:Maintenance'] },
      { label: 'About', sections: ['about:About'] },
    ]);
  });

  test('admin-only sections stay admin-only on every profile', () => {
    const desktopNonAdmin = groups('desktop', false).flatMap((group) => group.sections);
    expect(desktopNonAdmin).toEqual(['theme:Appearance', 'api:Voice', 'storage:Library and storage', 'account:Profile', 'about:About']);
  });

  test('respects the per-user provider tab flag', () => {
    const ids = groups('desktop', true, false).flatMap((group) => group.sections);
    expect(ids).not.toContain('api:Voice');
  });

  test('every section a profile shows has a place in its layout', () => {
    for (const installProfile of ['server', 'desktop'] as const) {
      const shown = SETTINGS_SECTIONS
        .filter((section) => !section.profiles || section.profiles.includes(installProfile))
        .map((section) => section.id)
        .sort();
      expect([...navLayoutIds(installProfile)].sort(), installProfile).toEqual(shown);
    }
  });
});

describe('install profile boundary check', () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test('the repository passes', () => {
    expect(findInstallProfileViolations(process.cwd())).toEqual([]);
  });

  test('flags installProfile in API routes, auth modules and middleware', () => {
    root = mkdtempSync(join(tmpdir(), 'openreader-install-profile-'));
    mkdirSync(join(root, 'src/app/api/example'), { recursive: true });
    mkdirSync(join(root, 'src/lib/server/auth'), { recursive: true });
    mkdirSync(join(root, 'src/components'), { recursive: true });
    writeFileSync(join(root, 'src/app/api/example/route.ts'), "if (config.installProfile === 'desktop') allow();\n");
    writeFileSync(join(root, 'src/lib/server/auth/guard.ts'), "import type { InstallProfile } from '@/lib/shared/install-profile';\n");
    writeFileSync(join(root, 'src/middleware.ts'), 'const ok = true;\nconst profile = runtime.installProfile;\n');
    writeFileSync(join(root, 'src/components/Menu.tsx'), "const desktop = installProfile === 'desktop';\n");
    expect(findInstallProfileViolations(root)).toEqual(expect.arrayContaining([
      { file: 'src/app/api/example/route.ts', line: 1 },
      { file: 'src/lib/server/auth/guard.ts', line: 1 },
      { file: 'src/middleware.ts', line: 2 },
    ]));
    expect(findInstallProfileViolations(root)).toHaveLength(3);
  });
});
