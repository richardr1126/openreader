'use client';

import { parseComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import { DatabaseIcon, UsersIcon } from '@/components/icons/Icons';
import { Section } from '@/components/ui';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { AdminSettingsSkeleton, useAdminSettingsDraft } from './admin-settings-draft';
import {
  COMPUTE_ACTION_GROUPS,
  ComputeActionRows,
  ProviderCapacityRow,
  WorkerCapacityRow,
} from './ComputeLimitsEditor';

const STORAGE_INFO = 'Documents plus generated audio. At the cap, uploads and new audio stop until space is freed.';

/** What each user may store and run, and how much the worker and providers take on at once. */
export function AdminLimitsPanel() {
  const { loaded, draft, update, source, toggle, number, saveBar } = useAdminSettingsDraft('Limits saved');
  const { providers } = useSharedProviders();

  if (!loaded) return <AdminSettingsSkeleton titles={['Storage', 'Daily allowances']} label="Loading limit settings" />;

  const policy = parseComputeLimitPolicyDocument(draft.computeLimitPolicies);
  const onPolicyChange = (next: unknown) => update('computeLimitPolicies', next);
  // One setting holds every compute group, so its origin shows once, on the first.
  const policySource = source('computeLimitPolicies');

  return (
    <div className="space-y-5">
      <Section title="Storage" variant="group">
        {toggle({ key: 'limitAccountStorage', label: 'Storage per account', icon: <DatabaseIcon />, info: STORAGE_INFO })}
        {draft.limitAccountStorage ? number({ key: 'accountStorageMb', label: 'Account storage cap', icon: <DatabaseIcon />, unit: 'MB' }) : null}
        {/* Shown while guests are off too, so caps can be set before guests are let in. */}
        {toggle({ key: 'limitGuestStorage', label: 'Storage per guest', icon: <DatabaseIcon />, info: STORAGE_INFO })}
        {draft.limitGuestStorage ? number({ key: 'guestStorageMb', label: 'Guest storage cap', icon: <DatabaseIcon />, unit: 'MB' }) : null}
        {toggle({
          key: 'limitGuestStoragePool',
          label: 'Total guest storage',
          icon: <UsersIcon />,
          info: 'Shared by all guests. When it is full, guests cannot upload or generate new audio. Accounts are unaffected.',
        })}
        {draft.limitGuestStoragePool ? number({ key: 'guestStoragePoolMb', label: 'Total guest storage cap', icon: <UsersIcon />, unit: 'MB' }) : null}
      </Section>

      {policy ? <>
        {COMPUTE_ACTION_GROUPS.map((group, index) => (
          <Section key={group.title} title={group.title} variant="group" footer={group.footer} action={index === 0 ? policySource : undefined}>
            <ComputeActionRows policy={policy} onChange={onPolicyChange} actions={group.actions} />
          </Section>
        ))}
        <Section title="Capacity" variant="group">
          <WorkerCapacityRow policy={policy} onChange={onPolicyChange} />
          <ProviderCapacityRow
            policy={policy}
            onChange={onPolicyChange}
            providers={providers.map(({ slug, displayName }) => ({ slug, displayName }))}
          />
        </Section>
      </> : null}

      {saveBar}
    </div>
  );
}
