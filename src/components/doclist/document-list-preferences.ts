import type {
  DocumentListState,
  IconSize,
  SidebarFilter,
  SortBy,
  SortDirection,
  ViewMode,
} from '@/types/documents';

export type NormalizedDocumentListState = {
  sortBy: SortBy;
  sortDirection: SortDirection;
  showHint: boolean;
  viewMode: ViewMode;
  iconSize: IconSize;
  sidebarWidth: number;
  sidebarFilter: SidebarFilter;
  sidebarCollapsed: boolean;
};

export const DEFAULT_DOCUMENT_LIST_STATE: NormalizedDocumentListState = {
  sortBy: 'name',
  sortDirection: 'asc',
  showHint: true,
  viewMode: 'icons',
  iconSize: 'md',
  sidebarWidth: 220,
  sidebarFilter: 'all',
  sidebarCollapsed: false,
};

function normalizeViewMode(stored: DocumentListState['viewMode']): ViewMode {
  if (stored === 'list' || stored === 'gallery') return stored;
  return 'icons';
}

export function normalizeDocumentListState(
  stored: DocumentListState | undefined | null,
): NormalizedDocumentListState {
  return {
    sortBy: stored?.sortBy ?? DEFAULT_DOCUMENT_LIST_STATE.sortBy,
    sortDirection: stored?.sortDirection ?? DEFAULT_DOCUMENT_LIST_STATE.sortDirection,
    showHint: stored?.showHint ?? DEFAULT_DOCUMENT_LIST_STATE.showHint,
    viewMode: normalizeViewMode(stored?.viewMode),
    iconSize: stored?.iconSize ?? DEFAULT_DOCUMENT_LIST_STATE.iconSize,
    sidebarWidth: stored?.sidebarWidth ?? DEFAULT_DOCUMENT_LIST_STATE.sidebarWidth,
    sidebarFilter: stored?.sidebarFilter ?? DEFAULT_DOCUMENT_LIST_STATE.sidebarFilter,
    sidebarCollapsed: stored?.sidebarCollapsed ?? DEFAULT_DOCUMENT_LIST_STATE.sidebarCollapsed,
  };
}

export function serializeDocumentListState(
  state: NormalizedDocumentListState,
): DocumentListState {
  return {
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    showHint: state.showHint,
    viewMode: state.viewMode,
    iconSize: state.iconSize,
    sidebarWidth: state.sidebarWidth,
    sidebarFilter: state.sidebarFilter,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}
