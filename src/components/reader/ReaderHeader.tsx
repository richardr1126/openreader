'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Header } from '@/components/Header';
import { ButtonLink } from '@/components/ui';

/** The reader's top bar. The way back to the library works in every reader state. */
export function ReaderHeader({
  title,
  right,
  onBackToDocuments,
}: {
  title?: ReactNode;
  right?: ReactNode;
  onBackToDocuments: (event: MouseEvent) => void;
}) {
  return (
    <Header
      left={
        <ButtonLink href="/app" variant="secondary" size="sm" className="gap-2" aria-label="Back to documents" onClick={onBackToDocuments}>
          <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Documents
        </ButtonLink>
      }
      title={title}
      right={right}
    />
  );
}
