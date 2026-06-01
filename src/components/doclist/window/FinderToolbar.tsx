'use client';

import { Listbox } from '@headlessui/react';
import type { IconSize, SortBy, SortDirection, ViewMode } from '@/types/documents';
import {
  IconsViewIcon,
  ListViewIcon,
  GalleryViewIcon,
  SearchIcon,
  HamburgerIcon,
} from './finderIcons';
import { ChevronUpDownIcon } from '@/components/icons/Icons';
import { SearchField, SharedListboxButton, SharedListboxOption, SharedListboxOptions, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSegment } from '@/components/ui';
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
    <Toolbar>
        {leftSlot && (
          <div className="shrink-0 flex items-center gap-2 pr-1 sm:pr-2 sm:border-r sm:border-line">
            {leftSlot}
          </div>
        )}

        <ToolbarButton
          onClick={onToggleSidebar}
          active={isSidebarOpen}
          className="shrink-0"
          aria-pressed={isSidebarOpen}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
        >
          <HamburgerIcon className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarGroup>
          {VIEW_BUTTONS.map(({ value, label, Icon }) => {
            const active = viewMode === value;
            const isIconsToggle = value === 'icons';
            return (
              <div
                key={value}
                className={isIconsToggle ? 'relative group/icons inline-flex items-center' : 'inline-flex items-center'}
              >
                <ToolbarSegment
                  onClick={() => onViewModeChange(value)}
                  active={active}
                  aria-pressed={active}
                  aria-label={`${label} view`}
                  title={`${label} view`}
                  className="w-7"
                >
                  <Icon className="w-4 h-4" />
                </ToolbarSegment>
                {isIconsToggle && viewMode === 'icons' && (
                  <div
                    className="absolute top-full left-1/2 z-30 -translate-x-1/2 pt-1 opacity-0 pointer-events-none transition-opacity duration-fast group-hover/icons:opacity-100 group-hover/icons:pointer-events-auto group-focus-within/icons:opacity-100 group-focus-within/icons:pointer-events-auto"
                  >
                    <ToolbarGroup className="shadow-elev-2">
                      {ICON_SIZES.map(({ value: sizeValue, label: sizeLabel }) => {
                        const sizeActive = iconSize === sizeValue;
                        return (
                          <ToolbarSegment
                            key={sizeValue}
                            onClick={() => onIconSizeChange(sizeValue)}
                            active={sizeActive}
                            aria-pressed={sizeActive}
                            aria-label={`Icon size ${sizeLabel}`}
                            className="min-w-[26px] px-1.5 font-semibold tracking-wide"
                          >
                            {sizeLabel}
                          </ToolbarSegment>
                        );
                      })}
                    </ToolbarGroup>
                  </div>
                )}
              </div>
            );
          })}
        </ToolbarGroup>

        {showSortControls && (
          <div className="flex items-center gap-1 shrink-0">
            <ToolbarButton onClick={onSortDirectionToggle} className="whitespace-nowrap" title="Toggle sort direction">
              {directionLabel}
            </ToolbarButton>
            <Listbox value={sortBy} onChange={onSortByChange}>
              <SharedListboxButton tone="toolbar" className="gap-1 min-w-[86px] justify-between">
                <span>{currentSort.label}</span>
                <ChevronUpDownIcon className="h-3 w-3 opacity-60" />
              </SharedListboxButton>
              <SharedListboxOptions anchor="bottom end" tone="compact">
                {SORT_OPTIONS.map((opt) => (
                  <SharedListboxOption
                    key={opt.value}
                    value={opt.value}
                    tone="compact"
                  >
                    {opt.label}
                  </SharedListboxOption>
                ))}
              </SharedListboxOptions>
            </Listbox>
          </div>
        )}

        <div className="flex-1 min-w-0" />

        <SearchField
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search"
          className="hidden w-[160px] md:w-[200px] sm:flex"
          icon={<SearchIcon className="w-3.5 h-3.5" />}
        />

        {rightSlot && (
          <div className="shrink-0 flex items-center gap-2 pl-1 sm:pl-2 sm:border-l sm:border-line ml-0.5">
            {rightSlot}
          </div>
        )}
    </Toolbar>
  );
}
