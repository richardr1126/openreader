'use client';

import type { ReactNode } from 'react';

import { ConfigProvider } from '@/contexts/ConfigContext';
import { TTSProvider } from '@/contexts/TTSContext';

export default function HtmlReaderLayout({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <TTSProvider>{children}</TTSProvider>
    </ConfigProvider>
  );
}
