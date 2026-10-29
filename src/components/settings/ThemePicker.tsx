'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ColorPicker } from '@/components/ColorPicker';
import { CheckIcon, MoonIcon, SunIcon } from '@/components/icons/Icons';
import { AnimatedCollapse } from './ExpandableSettingsCard';
import { THEMES, type CustomThemeColors } from '@/contexts/ThemeContext';

type ThemeColorSet = CustomThemeColors;
export type ThemeId = (typeof THEMES)[number];

const THEME_COLORS: Record<string, ThemeColorSet> = {
  light: { background: '#ffffff', base: '#f7fafc', offbase: '#e2e8f0', accent: '#ef4444', secondaryAccent: '#ed6868', foreground: '#2d3748', muted: '#718096' },
  dark: { background: '#111111', base: '#171717', offbase: '#343434', accent: '#f87171', secondaryAccent: '#eb6262', foreground: '#ededed', muted: '#a3a3a3' },
  ocean: { background: '#020617', base: '#0f172a', offbase: '#1e293b', accent: '#38bdf8', secondaryAccent: '#22d3ee', foreground: '#e2e8f0', muted: '#94a3b8' },
  forest: { background: '#0a0f0c', base: '#111a15', offbase: '#1a2820', accent: '#4ade80', secondaryAccent: '#22c55e', foreground: '#d4e8d0', muted: '#7c8f85' },
  sunset: { background: '#1a0f0f', base: '#2c1810', offbase: '#3d1f14', accent: '#ff6b6b', secondaryAccent: '#f59e0b', foreground: '#ffe4d6', muted: '#bc8f8f' },
  sea: { background: '#0c1922', base: '#102c3d', offbase: '#1a3c52', accent: '#06b6d4', secondaryAccent: '#0ea5e9', foreground: '#e0f2fe', muted: '#7ca7c4' },
  mint: { background: '#0f1916', base: '#132d27', offbase: '#1c3d35', accent: '#2dd4bf', secondaryAccent: '#10b981', foreground: '#dcfce7', muted: '#75a99c' },
  lavender: { background: '#faf8ff', base: '#f3effb', offbase: '#e4daf0', accent: '#7c3aed', secondaryAccent: '#a78bfa', foreground: '#3b2e5a', muted: '#8e7bab' },
  rose: { background: '#fff8f8', base: '#fef1f1', offbase: '#f5dada', accent: '#e11d48', secondaryAccent: '#f472b6', foreground: '#4a2c2c', muted: '#b08a8a' },
  sand: { background: '#fdfbf7', base: '#f7f2e8', offbase: '#e8dfc9', accent: '#b45309', secondaryAccent: '#d97706', foreground: '#44392a', muted: '#9a8b74' },
  sky: { background: '#f6faff', base: '#edf4fc', offbase: '#d5e3f5', accent: '#2563eb', secondaryAccent: '#3b82f6', foreground: '#1e3a5f', muted: '#6b8db5' },
  slate: { background: '#e8ecf0', base: '#dde2e8', offbase: '#c8ced6', accent: '#5b7a9d', secondaryAccent: '#7393b0', foreground: '#2c3440', muted: '#7a8694' },
};

const LIGHT_THEME_IDS = new Set(['light', 'lavender', 'rose', 'sand', 'sky', 'slate']);
const themeName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const presetThemes = THEMES.filter((id) => id !== 'custom' && id !== 'system');
const lightThemes = presetThemes.filter((id) => LIGHT_THEME_IDS.has(id));
const darkThemes = presetThemes.filter((id) => !LIGHT_THEME_IDS.has(id));
const CUSTOM_COLOR_FIELDS: { key: keyof CustomThemeColors; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'base', label: 'Base' },
  { key: 'offbase', label: 'Off-base' },
  { key: 'accent', label: 'Accent' },
  { key: 'secondaryAccent', label: 'Accent 2' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'muted', label: 'Muted' },
];

/** A miniature reader page drawn in the theme's own colors. */
function ThemePreview({ colors }: { colors: ThemeColorSet }) {
  return <span aria-hidden className="flex h-full flex-1 flex-col p-1.5" style={{ backgroundColor: colors.background }}>
    <span className="flex flex-1 flex-col justify-center gap-1 rounded px-1.5" style={{ backgroundColor: colors.base, boxShadow: `inset 0 0 0 1px ${colors.offbase}` }}>
      <span className="h-1 w-3/4 rounded-full" style={{ backgroundColor: colors.foreground }} />
      <span className="h-1 w-full rounded-full" style={{ backgroundColor: colors.muted }} />
      <span className="flex gap-1">
        <span className="h-1 w-1/3 rounded-full" style={{ backgroundColor: colors.accent }} />
        <span className="h-1 w-1/4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
      </span>
    </span>
  </span>;
}

function ThemeTile({ label, selected, onClick, children }: {
  label: string; selected: boolean; onClick: () => void; children: ReactNode;
}) {
  return <button type="button" aria-pressed={selected} onClick={onClick}
    className={`group flex min-w-0 flex-col overflow-hidden rounded-lg border text-left transition duration-base ease-standard focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
      selected ? 'border-accent ring-1 ring-accent' : 'border-line-soft hover:border-accent-line'}`}>
    <span className="flex h-11 overflow-hidden">{children}</span>
    <span className="flex items-center justify-between gap-2 border-t border-line-soft bg-surface-solid px-2.5 py-1.5 text-xs font-medium text-foreground">
      <span className="truncate">{label}</span>
      {selected ? <CheckIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
    </span>
  </button>;
}

function ThemeGrid({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return <div className="space-y-2">
    <h4 className="flex items-center gap-1.5 text-xs font-medium text-soft">{icon}{label}</h4>
    <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">{children}</div>
  </div>;
}

export function ThemePicker({ theme, customColors, onSelect, onCustomColorsChange }: {
  theme: ThemeId;
  customColors: CustomThemeColors;
  onSelect: (theme: ThemeId) => void;
  onCustomColorsChange: (colors: CustomThemeColors) => void;
}) {
  const [systemIsDark, setSystemIsDark] = useState(
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);
  const tile = (id: ThemeId) => <ThemeTile key={id} label={themeName(id)} selected={theme === id} onClick={() => onSelect(id)}>
    <ThemePreview colors={THEME_COLORS[id]} />
  </ThemeTile>;

  return <div className="space-y-4">
    <ThemeGrid label="Automatic and custom">
      <ThemeTile label="System" selected={theme === 'system'} onClick={() => onSelect('system')}>
        {/* Both halves show, the active one first, so the tile reads as "follows your device". */}
        <ThemePreview colors={THEME_COLORS[systemIsDark ? 'dark' : 'light']} />
        <ThemePreview colors={THEME_COLORS[systemIsDark ? 'light' : 'dark']} />
      </ThemeTile>
      <ThemeTile label="Custom" selected={theme === 'custom'} onClick={() => onSelect('custom')}>
        <ThemePreview colors={customColors} />
      </ThemeTile>
    </ThemeGrid>
    <AnimatedCollapse open={theme === 'custom'}>
      <div role="group" aria-label="Custom colors" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-2 rounded-md border border-line-soft bg-surface-sunken px-2.5 py-1.5">
            <span className="flex-1 truncate text-xs font-medium text-foreground">{label}</span>
            <span className="font-mono text-[10px] text-faint">{customColors[key]}</span>
            <ColorPicker value={customColors[key]} field={key} label={label}
              onChange={(color) => onCustomColorsChange({ ...customColors, [key]: color })} />
          </div>
        ))}
      </div>
    </AnimatedCollapse>
    <ThemeGrid label="Light" icon={<SunIcon className="h-3.5 w-3.5" aria-hidden />}>{lightThemes.map(tile)}</ThemeGrid>
    <ThemeGrid label="Dark" icon={<MoonIcon className="h-3.5 w-3.5" aria-hidden />}>{darkThemes.map(tile)}</ThemeGrid>
  </div>;
}
