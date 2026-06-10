'use client';

import { ReactNode } from 'react';
import { ModalFrame, ModalTitle, type DialogSize } from './dialog';
import { SidebarNav, SidebarNavItem } from './sidebar-nav';
import { cn } from './cn';

export type SidebarDialogSection<T extends string = string> = {
  id: T;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
};

export function SidebarDialog<T extends string = string>({
  open,
  onClose,
  size = 'xl',
  panelTestId,
  modalClassName,
  headerTitle,
  headerRight,
  showCloseButton = true,
  sections,
  activeSectionId,
  onSectionChange,
  children,
  className,
  contentClassName,
  customContent,
}: {
  open: boolean;
  onClose: () => void;
  size?: DialogSize;
  panelTestId?: string;
  modalClassName?: string;
  headerTitle: ReactNode;
  headerRight?: ReactNode;
  showCloseButton?: boolean;
  sections: SidebarDialogSection<T>[];
  activeSectionId: T;
  onSectionChange: (id: T) => void;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  customContent?: ReactNode;
}) {
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      size={size}
      panelTestId={panelTestId}
      className={modalClassName}
    >
      {customContent ? (
        customContent
      ) : (
        <div className={cn('flex flex-col h-[480px]', className)}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft shrink-0">
          <div className="flex items-baseline gap-4">
            <ModalTitle>{headerTitle}</ModalTitle>
          </div>
          <div className="flex items-center gap-2">
            {headerRight}
            {showCloseButton && (
              <button
                onClick={onClose}
                className="rounded-md p-1 text-soft hover:bg-accent-wash hover:text-foreground transition-colors duration-base"
                aria-label="Close dialog"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Mobile Navigation (Horizontal row of items) */}
        <SidebarNav layout="grid" className="sm:hidden border-b border-line-soft bg-background p-2 shrink-0">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <SidebarNavItem
                compact
                key={section.id}
                onClick={() => onSectionChange(section.id)}
                active={activeSectionId === section.id}
                icon={<Icon className="w-3.5 h-3.5" />}
                label={section.label}
              />
            );
          })}
        </SidebarNav>

        {/* Main Body (Split layout on desktop) */}
        <div className="flex flex-row min-h-0 flex-1">
          {/* Desktop Navigation (Left sidebar) */}
          <nav className="hidden sm:block w-fit shrink-0 border-r border-line-soft bg-background p-2">
            <SidebarNav>
              {sections.map((section) => {
                const Icon = section.icon;
                const active = activeSectionId === section.id;
                return (
                  <SidebarNavItem
                    key={section.id}
                    onClick={() => onSectionChange(section.id)}
                    active={active}
                    icon={<Icon className="w-4 h-4" />}
                    label={section.label}
                    className="whitespace-nowrap"
                  />
                );
              })}
            </SidebarNav>
          </nav>

          {/* Tab Panel Content (Right detail view) */}
          <div className={cn('flex-1 min-w-0 p-4 overflow-y-auto bg-surface', contentClassName)}>
            {children}
          </div>
        </div>
        </div>
      )}
    </ModalFrame>
  );
}
