'use client';

import type { ReactNode } from 'react';
import { SlidersIcon } from '@/components/icons/Icons';
import { RowIcon } from '@/components/ui';
import { ExpandableSettingsCard } from './ExpandableSettingsCard';

export function AdvancedSettings({ children }: { children: ReactNode }) {
  return <ExpandableSettingsCard label="Advanced" header={<><RowIcon><SlidersIcon /></RowIcon><span className="flex-1">Advanced</span></>}>
    {children}
  </ExpandableSettingsCard>;
}

export function AdvancedSettingsGroup({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section>
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
    {subtitle && <p className="mt-1 text-xs text-soft">{subtitle}</p>}
    <div className="divide-y divide-line-soft [&>*]:py-2.5">{children}</div>
  </section>;
}
