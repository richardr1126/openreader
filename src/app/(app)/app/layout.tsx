'use client';

import type { ReactNode } from 'react';

import { DocumentProvider } from '@/contexts/DocumentContext';
import { OnboardingFlowProvider } from '@/contexts/OnboardingFlowContext';

// ConfigProvider is mounted once in the shared (app) layout so it survives
// library <-> reader navigation; do not re-wrap it here.
export default function AppHomeLayout({ children }: { children: ReactNode }) {
  return (
    <DocumentProvider>
      <OnboardingFlowProvider>
        {children}
      </OnboardingFlowProvider>
    </DocumentProvider>
  );
}
