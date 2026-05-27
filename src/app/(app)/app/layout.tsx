'use client';

import type { ReactNode } from 'react';

import { ConfigProvider } from '@/contexts/ConfigContext';
import { DocumentProvider } from '@/contexts/DocumentContext';
import { OnboardingFlowProvider } from '@/contexts/OnboardingFlowContext';

export default function AppHomeLayout({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <DocumentProvider>
        <OnboardingFlowProvider>{children}</OnboardingFlowProvider>
      </DocumentProvider>
    </ConfigProvider>
  );
}
