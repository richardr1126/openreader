'use client';

import { Listbox } from '@headlessui/react';
import type {
  IconSize,
  ReadingStatusFilter,
  SortBy,
  SortDirection,
  ViewMode,
} from '@/types/documents';
import {
  IconsViewIcon,
  ListViewIcon,
  GalleryViewIcon,
  SearchIcon,
  HamburgerIcon,
} from './finderIcons';
import { ChevronUpDownIcon } from '@/components/icons/Icons';
import {
  PopoverRoot,
  PopoverSurface,
  PopoverTrigger,
  SearchField,
  SegmentedControl,
  SharedListboxButton,
  SharedListboxOption,
  SharedListboxOptions,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSegment,
  cn,
  toolbarButtonStyles,
} from '@/components/ui';
import { useState, type ReactNode } from 'react';
import { formatDocumentSize } from '@/components/doclist/formatSize';

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
  statusFilter: ReadingStatusFilter;
  onStatusFilterChange: (status: ReadingStatusFilter) => void;
  onToggleSidebar: () => void;
  isSidebarOpen: boolean;
  showSortControls?: boolean;
  itemCount: number;
  totalSize: number;
  /** App-level content rendered at the far left (brand/logo). */
  leftSlot?: ReactNode;
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
  { value: 'author', label: 'Author', asc: 'A → Z', desc: 'Z → A' },
  { value: 'opened', label: 'Opened', asc: 'Oldest', desc: 'Newest' },
];

const STATUS_OPTIONS: Array<{ value: ReadingStatusFilter; label: string }> = [
  { value: 'any', label: 'Any status' },
  { value: 'reading', label: 'In progress' },
  { value: 'unread', label: 'Not started' },
];

const ICON_SIZES: Array<{ value: IconSize; label: string }> = [
  { value: 'sm', label: 'S' },
  { value: 'md', label: 'M' },
  { value: 'lg', label: 'L' },
  { value: 'xl', label: 'XL' },
];

function MobileOption({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      {children}
    </div>
  );
}

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
  statusFilter,
  onStatusFilterChange,
  onToggleSidebar,
  isSidebarOpen,
  showSortControls = true,
  itemCount,
  totalSize,
  leftSlot,
}: FinderToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const currentSort = SORT_OPTIONS.find((o) => o.value === sortBy) ?? SORT_OPTIONS[0];
  const currentStatus = STATUS_OPTIONS.find((o) => o.value === statusFilter) ?? STATUS_OPTIONS[0];
  const directionLabel = sortDirection === 'asc' ? currentSort.asc : currentSort.desc;
  const CurrentViewIcon = VIEW_BUTTONS.find((b) => b.value === viewMode)?.Icon ?? IconsViewIcon;
  const closeSearch = () => {
    onQueryChange('');
    setSearchOpen(false);
  };

  return (
    <Toolbar>
      {searchOpen && (
        <div className="flex w-full items-center gap-2 sm:hidden">
          <SearchField
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
            placeholder="Search"
            aria-label="Search documents"
            className="flex-1 py-1.5"
            icon={<SearchIcon className="w-3.5 h-3.5" />}
          />
          <ToolbarButton onClick={closeSearch}>Cancel</ToolbarButton>
        </div>
      )}
      <div className={cn('items-center gap-1.5 sm:gap-2', searchOpen ? 'hidden sm:contents' : 'contents')}>
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

        <div className="hidden sm:contents">
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
        <Listbox value={statusFilter} onChange={onStatusFilterChange}>
          <SharedListboxButton
            tone="toolbar"
            aria-label={`Reading status: ${currentStatus.label}`}
            className="shrink-0 gap-1 min-w-[96px] justify-between"
          >
            <span className="flex items-center gap-1.5">
              {statusFilter !== 'any' && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
              )}
              {currentStatus.label}
            </span>
            <ChevronUpDownIcon className="h-3 w-3 opacity-60" />
          </SharedListboxButton>
          <SharedListboxOptions anchor="bottom end" tone="compact">
            {STATUS_OPTIONS.map((opt) => (
              <SharedListboxOption key={opt.value} value={opt.value} tone="compact">
                {opt.label}
              </SharedListboxOption>
            ))}
          </SharedListboxOptions>
        </Listbox>
        </div>

        <div className="flex-1 min-w-0" />

        <span
          role="status"
          aria-live="polite"
          aria-label={`${itemCount} item${itemCount === 1 ? '' : 's'}, ${formatDocumentSize(totalSize)}`}
          className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-soft"
        >
          <span className="sm:hidden">{itemCount}</span>
          <span className="hidden sm:inline">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <span className="mx-1 text-faint">•</span>
          {formatDocumentSize(totalSize)}
        </span>

        <SearchField
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search"
          aria-label="Search documents"
          className="hidden w-[160px] md:w-[200px] sm:flex"
          icon={<SearchIcon className="w-3.5 h-3.5" />}
        />

        {/* Phones: search and view/sort tuck behind two icon buttons. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:hidden">
          <ToolbarButton onClick={() => setSearchOpen(true)} aria-label="Search" title="Search">
            <SearchIcon className="w-4 h-4" />
          </ToolbarButton>
          <PopoverRoot className="relative">
            <PopoverTrigger className={toolbarButtonStyles()} aria-label="View, sort, and filter options">
              <CurrentViewIcon className="w-4 h-4" />
              <ChevronUpDownIcon className="ml-1 h-3 w-3 opacity-60" />
            </PopoverTrigger>
            <PopoverSurface anchor="bottom end" className="w-[min(20rem,calc(100vw-1rem))] space-y-3">
              <MobileOption label="View">
                <SegmentedControl
                  ariaLabel="View mode"
                  value={viewMode}
                  onChange={onViewModeChange}
                  className="grid-cols-3"
                  options={VIEW_BUTTONS.map(({ value, label }) => ({ value, label }))}
                />
              </MobileOption>
              {viewMode === 'icons' && (
                <MobileOption label="Icon size">
                  <SegmentedControl
                    ariaLabel="Icon size"
                    value={iconSize}
                    onChange={onIconSizeChange}
                    className="grid-cols-4"
                    options={ICON_SIZES}
                  />
                </MobileOption>
              )}
              {showSortControls && (
                <>
                  <MobileOption label="Sort by">
                    <SegmentedControl
                      ariaLabel="Sort by"
                      value={sortBy}
                      onChange={onSortByChange}
                      className="grid-cols-3"
                      options={SORT_OPTIONS.map(({ value, label }) => ({ value, label }))}
                    />
                  </MobileOption>
                  <MobileOption label="Order">
                    <SegmentedControl
                      ariaLabel="Sort order"
                      value={sortDirection}
                      onChange={(dir) => dir !== sortDirection && onSortDirectionToggle()}
                      className="grid-cols-2"
                      options={[
                        { value: 'asc', label: currentSort.asc },
                        { value: 'desc', label: currentSort.desc },
                      ]}
                    />
                  </MobileOption>
                </>
              )}
              <MobileOption label="Status">
                <SegmentedControl
                  ariaLabel="Reading status"
                  value={statusFilter}
                  onChange={onStatusFilterChange}
                  className="grid-cols-3"
                  options={STATUS_OPTIONS.map(({ value, label }) => ({
                    value,
                    label: value === 'any' ? 'Any' : label,
                  }))}
                />
              </MobileOption>
            </PopoverSurface>
          </PopoverRoot>
        </div>
      </div>
    </Toolbar>
  );
}
