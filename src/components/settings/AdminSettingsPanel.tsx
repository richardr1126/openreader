'use client';

import { useState } from 'react';
import { AdminFeaturesPanel } from '@/components/admin/AdminFeaturesPanel';
import { AdminProvidersPanel } from '@/components/admin/AdminProvidersPanel';
import { AdminTasksPanel } from '@/components/admin/AdminTasksPanel';
import {
  ClockIcon,
  KeyIcon,
  SettingsIcon,
  SpeedometerIcon,
} from '@/components/icons/Icons';

type AdminSubTab = 'providers' | 'instance' | 'compute' | 'maintenance';

const ADMIN_AREAS = [
  {
    id: 'providers' as const,
    label: 'Providers',
    description: 'Credentials, models, and shared access',
    icon: KeyIcon,
  },
  {
    id: 'instance' as const,
    label: 'Instance',
    description: 'Defaults, sign-ups, and feature access',
    icon: SettingsIcon,
  },
  {
    id: 'compute' as const,
    label: 'Compute',
    description: 'Limits, playback, retries, and cache',
    icon: SpeedometerIcon,
  },
  {
    id: 'maintenance' as const,
    label: 'Maintenance',
    description: 'Cleanup schedules and recent results',
    icon: ClockIcon,
  },
];

export function AdminSettingsPanel() {
  const [activeTab, setActiveTab] = useState<AdminSubTab>('providers');

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-6">
      <nav
        aria-label="Administration areas"
        className="flex gap-1 overflow-x-auto border-b border-line-soft pb-3 lg:block lg:space-y-1 lg:overflow-visible lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4"
      >
        {ADMIN_AREAS.map((area) => {
          const Icon = area.icon;
          const active = area.id === activeTab;
          return (
            <button
              key={area.id}
              type="button"
              onClick={() => setActiveTab(area.id)}
              aria-current={active ? 'page' : undefined}
              className={`group flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition duration-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:w-full lg:items-start ${
                active
                  ? 'border-accent-line bg-accent-wash text-accent'
                  : 'border-transparent text-soft hover:bg-surface hover:text-foreground'
              }`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-accent' : 'text-faint group-hover:text-accent'}`} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold sm:text-sm">{area.label}</span>
                <span className="mt-0.5 hidden text-[11px] leading-4 text-soft lg:block">
                  {area.description}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-faint">
            {ADMIN_AREAS.find((area) => area.id === activeTab)?.label}
          </p>
          <p className="mt-1 text-sm text-soft">
            {ADMIN_AREAS.find((area) => area.id === activeTab)?.description}
          </p>
        </div>
        {activeTab === 'providers' ? <AdminProvidersPanel /> : null}
        {activeTab === 'instance' ? <AdminFeaturesPanel scope="instance" /> : null}
        {activeTab === 'compute' ? <AdminFeaturesPanel scope="compute" /> : null}
        {activeTab === 'maintenance' ? <AdminTasksPanel /> : null}
      </div>
    </div>
  );
}
