'use client';

import { useCallback, useEffect, useState } from 'react';
import { ColorPicker } from '@/components/ColorPicker';
import { CheckIcon } from '@/components/icons/Icons';
import { ChoiceTile, IconButton } from '@/components/ui';
import {
  getCustomThemeColors,
  THEMES,
  type CustomThemeColors,
  useTheme,
} from '@/contexts/ThemeContext';

type ThemeColorSet = {
  background: string;
  base: string;
  offbase: string;
  accent: string;
  secondaryAccent: string;
  foreground: string;
  muted: string;
};
type ThemeId = (typeof THEMES)[number];

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
const allThemes = THEMES.filter((id) => id !== 'custom').map((id) => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
}));
const systemTheme = allThemes.find((theme) => theme.id === 'system')!;
const lightThemes = allThemes.filter((theme) => LIGHT_THEME_IDS.has(theme.id));
const darkThemes = allThemes.filter(
  (theme) => theme.id !== 'system' && !LIGHT_THEME_IDS.has(theme.id),
);
const CUSTOM_COLOR_FIELDS: { key: keyof CustomThemeColors; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'base', label: 'Base' },
  { key: 'offbase', label: 'Off-base' },
  { key: 'accent', label: 'Accent' },
  { key: 'secondaryAccent', label: 'Accent 2' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'muted', label: 'Muted' },
];

function ThemeSwatches({ colors }: { colors: ThemeColorSet }) {
  return (
    <div className="flex gap-1 ml-auto">
      <div className="w-4 h-4 rounded-full border border-line" style={{ backgroundColor: colors.background }} />
      <div className="w-4 h-4 rounded-full border border-line" style={{ backgroundColor: colors.offbase }} />
      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.accent }} />
      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.muted }} />
    </div>
  );
}

function ThemeChoice({
  label,
  colors,
  selected,
  onClick,
  className,
}: {
  label: string;
  colors: ThemeColorSet;
  selected: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <ChoiceTile
      selected={selected}
      onClick={onClick}
      className={className}
      style={{ backgroundColor: colors.base }}
    >
      {selected ? (
        <CheckIcon className="h-3.5 w-3.5 shrink-0" style={{ color: colors.accent }} />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <span className="text-xs font-medium w-14 shrink-0" style={{ color: colors.foreground }}>
        {label}
      </span>
      <ThemeSwatches colors={colors} />
    </ChoiceTile>
  );
}

export function AppearanceSettingsPanel() {
  const { theme, setTheme, applyCustomColors } = useTheme();
  const [customColors, setCustomColors] = useState<CustomThemeColors>(getCustomThemeColors);
  const [isCustomExpanded, setIsCustomExpanded] = useState(false);
  const [systemIsDark, setSystemIsDark] = useState(
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const getThemeColors = useCallback((id: string): ThemeColorSet => {
    if (id === 'system') return THEME_COLORS[systemIsDark ? 'dark' : 'light'];
    if (id === 'custom') return customColors;
    return THEME_COLORS[id] || THEME_COLORS.light;
  }, [customColors, systemIsDark]);

  const customThemeColors = getThemeColors('custom');

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <ThemeChoice
          label={systemTheme.name}
          colors={getThemeColors(systemTheme.id)}
          selected={theme === systemTheme.id}
          onClick={() => setTheme(systemTheme.id)}
          className="w-full"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-soft uppercase tracking-wide">Custom</label>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <ThemeChoice
              label="Custom"
              colors={customThemeColors}
              selected={theme === 'custom'}
              onClick={() => {
                setTheme('custom');
                setIsCustomExpanded(true);
              }}
              className="flex-1"
            />
            <IconButton
              onClick={() => setIsCustomExpanded((expanded) => !expanded)}
              tone="surface"
              size="sm"
              className="shrink-0"
              style={{ color: customThemeColors.muted, backgroundColor: customThemeColors.base }}
              aria-label={isCustomExpanded ? 'Collapse color picker' : 'Expand color picker'}
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform duration-base ${isCustomExpanded ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </IconButton>
          </div>

          {isCustomExpanded && (
            <div
              className="rounded-lg border p-3 space-y-2"
              style={{
                backgroundColor: customThemeColors.background,
                borderColor: theme === 'custom'
                  ? customThemeColors.accent
                  : customThemeColors.offbase,
              }}
            >
              <div className="flex flex-col gap-1">
                {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
                  <div
                    key={key}
                    className="grid items-center rounded-md px-2 py-1"
                    style={{
                      backgroundColor: customThemeColors.base,
                      gridTemplateColumns: '5rem 1fr auto',
                      gap: '0.5rem',
                    }}
                  >
                    <span
                      className="text-xs font-medium truncate"
                      style={{ color: customThemeColors.foreground }}
                    >
                      {label}
                    </span>
                    <span
                      className="text-[10px] font-mono text-right"
                      style={{ color: customThemeColors.muted }}
                    >
                      {customColors[key]}
                    </span>
                    <ColorPicker
                      value={customColors[key]}
                      field={key}
                      label={label}
                      onChange={(color) => {
                        const updated = { ...customColors, [key]: color };
                        setCustomColors(updated);
                        applyCustomColors(updated);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ThemeGroup label="Light" themes={lightThemes} activeTheme={theme} getColors={getThemeColors} onSelect={setTheme} />
      <ThemeGroup label="Dark" themes={darkThemes} activeTheme={theme} getColors={getThemeColors} onSelect={setTheme} />
    </div>
  );
}

function ThemeGroup({
  label,
  themes,
  activeTheme,
  getColors,
  onSelect,
}: {
  label: string;
  themes: { id: ThemeId; name: string }[];
  activeTheme: ThemeId;
  getColors: (id: string) => ThemeColorSet;
  onSelect: (id: ThemeId) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-soft uppercase tracking-wide">{label}</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {themes.map((theme) => (
          <ThemeChoice
            key={theme.id}
            label={theme.name}
            colors={getColors(theme.id)}
            selected={activeTheme === theme.id}
            onClick={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}
