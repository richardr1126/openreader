'use client';

import { useState } from 'react';
import { AdminFeaturesPanel } from '@/components/admin/AdminFeaturesPanel';
import { AdminProvidersPanel } from '@/components/admin/AdminProvidersPanel';
import { AdminTasksPanel } from '@/components/admin/AdminTasksPanel';
import { SegmentedControl } from '@/components/ui';

type AdminSubTab = 'providers' | 'features' | 'tasks';

export function AdminSettingsPanel() {
  const [activeTab, setActiveTab] = useState<AdminSubTab>('providers');

  return (
    <div className="space-y-4">
      <SegmentedControl
        value={activeTab}
        options={[
          { value: 'providers', label: 'Shared providers' },
          { value: 'features', label: 'Site features' },
          { value: 'tasks', label: 'Tasks' },
        ]}
        onChange={setActiveTab}
        ariaLabel="Admin tab"
        className="grid-cols-3"
      />
      {activeTab === 'providers' && <AdminProvidersPanel />}
      {activeTab === 'features' && <AdminFeaturesPanel />}
      {activeTab === 'tasks' && <AdminTasksPanel />}
    </div>
  );
}
