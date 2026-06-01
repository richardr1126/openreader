'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { Popover, PopoverButton } from '@headlessui/react';
import { isLightColor, type CustomThemeColors } from '@/contexts/ThemeContext';
import { PaletteIcon } from '@/components/icons/Icons';
import { IconButton, Input, PopoverSurface } from '@/components/ui';

/**
 * Curated swatch palettes per color role, sourced from existing themes
 * plus hand-picked pastels and bold tones for variety.
 */
/* 18 swatches each → 3 clean rows of 6 */
const ROLE_SWATCHES: Record<keyof CustomThemeColors, string[]> = {
  background: [
    '#111111', '#020617', '#0a0f0c', '#1a0f0f', '#0c1922', '#0f1916',
    '#ffffff', '#faf8ff', '#fff8f8', '#fdfbf7', '#f6faff', '#e8ecf0',
    '#fef3c7', '#fce7f3', '#e0e7ff', '#d1fae5', '#f5f3ff', '#fff1f2',
  ],
  base: [
    '#171717', '#0f172a', '#111a15', '#2c1810', '#102c3d', '#132d27',
    '#f7fafc', '#f3effb', '#fef1f1', '#f7f2e8', '#edf4fc', '#dde2e8',
    '#fefce8', '#fdf2f8', '#eef2ff', '#ecfdf5', '#faf5ff', '#fff5f5',
  ],
  offbase: [
    '#343434', '#1e293b', '#1a2820', '#3d1f14', '#1a3c52', '#1c3d35',
    '#e2e8f0', '#e4daf0', '#f5dada', '#e8dfc9', '#d5e3f5', '#c8ced6',
    '#fde68a', '#fbcfe8', '#c7d2fe', '#a7f3d0', '#e9d5ff', '#fecdd3',
  ],
  accent: [
    '#ef4444', '#f87171', '#38bdf8', '#4ade80', '#ff6b6b', '#06b6d4',
    '#2dd4bf', '#7c3aed', '#e11d48', '#b45309', '#2563eb', '#e94560',
    '#f59e0b', '#ec4899', '#8b5cf6', '#10b981', '#f97316', '#5b7a9d',
  ],
  secondaryAccent: [
    '#ed6868', '#eb6262', '#22d3ee', '#22c55e', '#f59e0b', '#0ea5e9',
    '#10b981', '#a78bfa', '#f472b6', '#d97706', '#3b82f6', '#f78da7',
    '#fbbf24', '#f9a8d4', '#34d399', '#fb923c', '#7393b0', '#c084fc',
  ],
  foreground: [
    '#2d3748', '#ededed', '#e2e8f0', '#d4e8d0', '#ffe4d6', '#e0f2fe',
    '#dcfce7', '#3b2e5a', '#4a2c2c', '#44392a', '#1e3a5f', '#2c3440',
    '#1c1917', '#18181b', '#1e293b', '#064e3b', '#4c1d95', '#881337',
  ],
  muted: [
    '#718096', '#a3a3a3', '#94a3b8', '#7c8f85', '#bc8f8f', '#7ca7c4',
    '#75a99c', '#8e7bab', '#b08a8a', '#9a8b74', '#6b8db5', '#7a8694',
    '#d4d4d8', '#a1a1aa', '#78716c', '#6b7280', '#9ca3af', '#64748b',
  ],
};

interface ColorPickerProps {
  value: string;
  field: keyof CustomThemeColors;
  label: string;
  onChange: (color: string) => void;
}

export function ColorPicker({ value, field, label, onChange }: ColorPickerProps) {
  const [hexInput, setHexInput] = useState(value);
  const nativeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHexInput(value);
  }, [value]);

  const handleHexCommit = useCallback((raw: string) => {
    let hex = raw.trim();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      onChange(hex.toLowerCase());
    } else {
      // revert to current value
      setHexInput(value);
    }
  }, [onChange, value]);

  const swatches = ROLE_SWATCHES[field];

  return (
    <Popover className="relative flex items-center">
      <PopoverButton as={IconButton} size="sm" className="group rounded-full p-0" aria-label={`Pick ${label} color`}>
        <div
          className="w-6 h-6 rounded-full border-2 transition duration-fast group-focus-visible:ring-2 group-focus-visible:ring-offset-1"
          style={{
            backgroundColor: value,
            borderColor: isLightColor(value) ? '#00000022' : '#ffffff22',
          }}
        />
      </PopoverButton>

      <PopoverSurface
        anchor="bottom start"
        transition
        className="z-[60] mt-2 w-56 bg-background space-y-3 transition duration-fast ease-standard data-[closed]:opacity-0 data-[closed]:scale-95"
      >
        {/* Label */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
            {label}
          </span>
          {/* Eyedropper / native picker */}
          <div className="relative">
            <IconButton
              type="button"
              onClick={() => nativeRef.current?.click()}
              size="xs"
              aria-label="Open system color picker"
            >
              <PaletteIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
            </IconButton>
            <input
              ref={nativeRef}
              type="color"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="absolute inset-0 w-full h-full opacity-0 pointer-events-none"
              tabIndex={-1}
              aria-hidden
            />
          </div>
        </div>

        {/* Swatch grid */}
        <div className="grid grid-cols-6 gap-1.5">
          {swatches.map((color) => {
            const selected = color.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={color}
                type="button"
                onClick={() => onChange(color)}
                className="group/swatch relative w-full aspect-square rounded-full transition-transform duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                style={{
                  backgroundColor: color,
                  boxShadow: selected ? '0 0 0 2px var(--background), 0 0 0 4px var(--foreground)' : undefined,
                }}
                aria-label={color}
              >
                {selected && (
                  <svg className="absolute inset-0 m-auto w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke={isLightColor(color) ? '#000' : '#fff'} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        {/* Hex input */}
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg border shrink-0"
            style={{
              backgroundColor: value,
              borderColor: isLightColor(value) ? '#00000018' : '#ffffff18',
            }}
          />
          <Input
            type="text"
            value={hexInput}
            onChange={(e) => setHexInput(e.target.value)}
            onBlur={(e) => handleHexCommit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleHexCommit(hexInput);
            }}
            spellCheck={false}
            maxLength={7}
            controlSize="sm"
            className="flex-1 font-mono"
          />
        </div>
      </PopoverSurface>
    </Popover>
  );
}
