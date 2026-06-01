'use client';

import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import type { IconSize, SortBy, SortDirection, ViewMode } from '@/types/documents';
import {
  IconsViewIcon,
  ListViewIcon,
  GalleryViewIcon,
  SearchIcon,
  HamburgerIcon,
} from './finderIcons';
import { ChevronUpDownIcon } from '@/components/icons/Icons';
import type { ReactNode } from 'react';

interface FinderToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  iconSize: IconSize;
  onIconSizeChange: (size: IconSize) => void;
  sortBy: SortBy;
  sortDirection: SortDirection;
  onSortByChange: (s: SortBy) => void;
  onSortDirectionToggle: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  onToggleSidebar: () => void;
  isSidebarOpen: boolean;
  showSortControls?: boolean;
  /** App-level content rendered at the far left (brand/logo). */
  leftSlot?: ReactNode;
  /** App-level content rendered at the far right (settings, user menu). */
  rightSlot?: ReactNode;
}

const VIEW_BUTTONS: Array<{ value: ViewMode; label: string; Icon: typeof IconsViewIcon }> = [
  { value: 'icons', label: 'Icons', Icon: IconsViewIcon },
  { value: 'list', label: 'List', Icon: ListViewIcon },
  { value: 'gallery', label: 'Gallery', Icon: GalleryViewIcon },
];

const SORT_OPTIONS: Array<{ value: SortBy; label: string; asc: string; desc: string }> = [
  { value: 'name', label: 'Name', asc: 'A → Z', desc: 'Z → A' },
  { value: 'type', label: 'Kind', asc: 'A → Z', desc: 'Z → A' },
  { value: 'date', label: 'Modified', asc: 'Oldest', desc: 'Newest' },
  { value: 'size', label: 'Size', asc: 'Smallest', desc: 'Largest' },
];

const ICON_SIZES: Array<{ value: IconSize; label: string }> = [
  { value: 'sm', label: 'S' },
  { value: 'md', label: 'M' },
  { value: 'lg', label: 'L' },
  { value: 'xl', label: 'XL' },
];

// Match SettingsModal / UserMenu trigger sizing exactly so all bar buttons share one rhythm.
const TOOLBAR_BTN =
  'inline-flex items-center py-1 px-2 rounded-md border bg-surface text-xs transition duration-base ease-standard';
const TOOLBAR_BTN_INACTIVE =
  'border-line text-foreground hover:text-accent hover:border-accent-line hover:bg-accent-wash';
const TOOLBAR_BTN_ACTIVE = 'border-accent-line bg-surface-sunken text-accent';

// Pill-grouped segmented control. Outer pill carries the border; inner segments are
// borderless and rely on bg/text color to show active/hover. Sized so the whole pill
// matches the height of a standalone TOOLBAR_BTN.
const PILL = 'inline-flex items-center rounded-md border border-line bg-surface p-0.5 gap-0.5 shrink-0';
const PILL_SEGMENT =
  'inline-flex items-center justify-center rounded-sm text-xs transition-colors duration-base ease-standard';
const PILL_SEGMENT_INACTIVE = 'text-soft hover:bg-accent-wash hover:text-accent';
const PILL_SEGMENT_ACTIVE = 'bg-surface-sunken text-accent';

export function FinderToolbar({
  viewMode,
  onViewModeChange,
  iconSize,
  onIconSizeChange,
  sortBy,
  sortDirection,
  onSortByChange,
  onSortDirectionToggle,
  query,
  onQueryChange,
  onToggleSidebar,
  isSidebarOpen,
  showSortControls = true,
  leftSlot,
  rightSlot,
}: FinderToolbarProps) {
  const currentSort = SORT_OPTIONS.find((o) => o.value === sortBy) ?? SORT_OPTIONS[0];
  const directionLabel = sortDirection === 'asc' ? currentSort.asc : currentSort.desc;

  return (
    <div className="sticky top-0 z-40 w-full border-b border-line-soft bg-surface">
      <div className="px-2 sm:px-3 py-1 min-h-10 flex items-center gap-1.5 sm:gap-2">
        {leftSlot && (
          <div className="shrink-0 flex items-center gap-2 pr-1 sm:pr-2 sm:border-r sm:border-line">
            {leftSlot}
          </div>
        )}

        <button
          type="button"
          onClick={onToggleSidebar}
          className={`${TOOLBAR_BTN} ${isSidebarOpen ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_INACTIVE} shrink-0`}
          aria-pressed={isSidebarOpen}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
        >
          <HamburgerIcon className="w-4 h-4" />
        </button>

        <div className={PILL}>
          {VIEW_BUTTONS.map(({ value, label, Icon }) => {
            const active = viewMode === value;
            const isIconsToggle = value === 'icons';
            return (
              <div
                key={value}
                className={isIconsToggle ? 'relative group/icons inline-flex items-center' : 'inline-flex items-center'}
              >
                <button
                  type="button"
                  onClick={() => onViewModeChange(value)}
                  aria-pressed={active}
                  aria-label={`${label} view`}
                  title={`${label} view`}
                  className={
                    PILL_SEGMENT +
                    ' h-6 w-7 ' +
                    (active ? PILL_SEGMENT_ACTIVE : PILL_SEGMENT_INACTIVE)
                  }
                >
                  <Icon className="w-4 h-4" />
                </button>
                {isIconsToggle && viewMode === 'icons' && (
                  <div
                    className="absolute top-full left-1/2 z-30 -translate-x-1/2 pt-1 opacity-0 pointer-events-none transition-opacity duration-fast group-hover/icons:opacity-100 group-hover/icons:pointer-events-auto group-focus-within/icons:opacity-100 group-focus-within/icons:pointer-events-auto"
                  >
                    <div className={`${PILL} shadow-elev-2`}>
                      {ICON_SIZES.map(({ value: sizeValue, label: sizeLabel }) => {
                        const sizeActive = iconSize === sizeValue;
                        return (
                          <button
                            key={sizeValue}
                            type="button"
                            onClick={() => onIconSizeChange(sizeValue)}
                            aria-pressed={sizeActive}
                            aria-label={`Icon size ${sizeLabel}`}
                            className={
                              PILL_SEGMENT +
                              ' h-6 min-w-[26px] px-1.5 font-semibold tracking-wide ' +
                              (sizeActive ? PILL_SEGMENT_ACTIVE : PILL_SEGMENT_INACTIVE)
                            }
                          >
                            {sizeLabel}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {showSortControls && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onSortDirectionToggle}
              className={`${TOOLBAR_BTN} ${TOOLBAR_BTN_INACTIVE} whitespace-nowrap`}
              title="Toggle sort direction"
            >
              {directionLabel}
            </button>
            <Listbox value={sortBy} onChange={onSortByChange}>
              <ListboxButton
                className={`${TOOLBAR_BTN} ${TOOLBAR_BTN_INACTIVE} gap-1 min-w-[90px] justify-between`}
              >
                <span>{currentSort.label}</span>
                <ChevronUpDownIcon className="h-3 w-3 opacity-60" />
              </ListboxButton>
              <ListboxOptions
                anchor="bottom end"
                className="z-50 mt-1 rounded-md bg-surface-sunken border border-line shadow-elev-2 p-1 focus:outline-none"
              >
                {SORT_OPTIONS.map((opt) => (
                  <ListboxOption
                    key={opt.value}
                    value={opt.value}
                    className={({ active, selected }) =>
                      `cursor-pointer select-none rounded-sm py-1.5 px-2.5 text-xs ${
                        active ? 'bg-surface-sunken text-accent' : 'text-foreground'
                      } ${selected ? 'font-semibold' : ''}`
                    }
                  >
                    {opt.label}
                  </ListboxOption>
                ))}
              </ListboxOptions>
            </Listbox>
          </div>
        )}

        <div className="flex-1 min-w-0" />

        <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-sunken border border-line hover:border-accent-line focus-within:ring-1 focus-within:ring-accent-line focus-within:border-accent-line transition-colors duration-base ease-standard w-[160px] md:w-[200px]">
          <SearchIcon className="w-3.5 h-3.5 text-soft shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search"
            className="flex-1 min-w-0 bg-transparent outline-none text-xs text-foreground placeholder:text-soft"
          />
        </div>

        {rightSlot && (
          <div className="shrink-0 flex items-center gap-2 pl-1 sm:pl-2 sm:border-l sm:border-line ml-0.5">
            {rightSlot}
          </div>
        )}
      </div>
    </div>
  );
}
