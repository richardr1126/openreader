'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useLayoutEffect } from 'react';

const THEMES = ['system', 'light', 'dark', 'ocean', 'forest', 'sunset', 'sea', 'mint', 'lavender', 'rose', 'sand', 'sky', 'slate', 'custom'] as const;
type Theme = (typeof THEMES)[number];

export interface CustomThemeColors {
  background: string;
  foreground: string;
  base: string;
  offbase: string;
  accent: string;
  secondaryAccent: string;
  muted: string;
}

const CUSTOM_THEME_STORAGE_KEY = 'customThemeColors';

const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  background: '#1a1a2e',
  foreground: '#e0e0e0',
  base: '#16213e',
  offbase: '#0f3460',
  accent: '#e94560',
  secondaryAccent: '#f78da7',
  muted: '#7f8c8d',
};

export function getCustomThemeColors(): CustomThemeColors {
  if (typeof window === 'undefined') return DEFAULT_CUSTOM_COLORS;
  try {
    const stored = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (stored) return { ...DEFAULT_CUSTOM_COLORS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CUSTOM_COLORS;
}

export function setCustomThemeColors(colors: CustomThemeColors): void {
  localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(colors));
}

function applyCustomThemeVariables(colors: CustomThemeColors): void {
  const root = document.documentElement;
  root.style.setProperty('--background', colors.background);
  root.style.setProperty('--foreground', colors.foreground);
  root.style.setProperty('--base', colors.base);
  root.style.setProperty('--offbase', colors.offbase);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--secondary-accent', colors.secondaryAccent);
  root.style.setProperty('--muted', colors.muted);
  root.style.setProperty('--prism-gradient', `linear-gradient(90deg, ${colors.accent}, ${colors.secondaryAccent}, ${colors.muted})`);
}

function clearCustomThemeVariables(): void {
  const root = document.documentElement;
  const vars = ['--background', '--foreground', '--base', '--offbase', '--accent', '--secondary-accent', '--muted', '--prism-gradient'];
  vars.forEach(v => root.style.removeProperty(v));
}

/** Returns true if the hex color is perceptually light (luminance > 0.5) */
function isLightColor(hex: string): boolean {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.5;
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Call to live-update custom theme colors while the custom theme is active */
  applyCustomColors: (colors: CustomThemeColors) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const getSystemTheme = () => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const STATIC_LIGHT_THEMES: ReadonlySet<string> = new Set(['light', 'lavender', 'rose', 'sand', 'sky', 'slate']);

const getEffectiveTheme = (theme: Theme): Theme => {
  if (theme === 'system') {
    return getSystemTheme();
  }
  return theme;
};

const getColorScheme = (theme: Theme): string => {
  if (theme === 'custom') {
    return isLightColor(getCustomThemeColors().background) ? 'light' : 'dark';
  }
  return STATIC_LIGHT_THEMES.has(theme) ? 'light' : 'dark';
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  // Initialize theme as early as possible to prevent flash
  useLayoutEffect(() => {
    const stored = localStorage.getItem('theme') as Theme;
    const initialTheme = stored && THEMES.includes(stored) ? stored : 'system';
    // Browser storage is only readable after mount; a layout effect applies it before paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initialTheme);
    const effectiveTheme = getEffectiveTheme(initialTheme);
    document.documentElement.classList.remove(...THEMES);
    document.documentElement.classList.add(effectiveTheme);
    document.documentElement.style.colorScheme = getColorScheme(effectiveTheme);
    if (effectiveTheme === 'custom') {
      applyCustomThemeVariables(getCustomThemeColors());
    }
    if (!stored) {
      localStorage.setItem('theme', initialTheme);
    }
    setMounted(true);
  }, []);

  const handleThemeChange = (newTheme: Theme) => {
    const root = window.document.documentElement;
    const effectiveTheme = getEffectiveTheme(newTheme);

    // Clear inline vars from a previous custom theme before switching
    if (theme === 'custom' && effectiveTheme !== 'custom') {
      clearCustomThemeVariables();
    }

    root.classList.remove(...THEMES);
    root.classList.add(effectiveTheme);
    root.style.colorScheme = getColorScheme(effectiveTheme);

    if (effectiveTheme === 'custom') {
      applyCustomThemeVariables(getCustomThemeColors());
    }

    localStorage.setItem('theme', newTheme);
    setTheme(newTheme);
  };

  const handleApplyCustomColors = (colors: CustomThemeColors) => {
    setCustomThemeColors(colors);
    if (theme === 'custom') {
      applyCustomThemeVariables(colors);
      document.documentElement.style.colorScheme = isLightColor(colors.background) ? 'light' : 'dark';
    }
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = () => {
      if (theme === 'system') {
        const effectiveTheme = getSystemTheme();
        const root = window.document.documentElement;
        root.classList.remove(...THEMES);
        root.classList.add(effectiveTheme);
        root.style.colorScheme = getColorScheme(effectiveTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Prevent flash during SSR
  if (!mounted) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleThemeChange, applyCustomColors: handleApplyCustomColors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export { THEMES, isLightColor };
