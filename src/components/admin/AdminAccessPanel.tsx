'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { HourglassIcon, UserIcon, UserPlusIcon } from '@/components/icons/Icons';
import { Section, SegmentedControl, SettingRow } from '@/components/ui';
import { fetchTasks } from '@/components/admin/AdminTasksPanel';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { AdminSettingsSkeleton, useAdminSettingsDraft } from './admin-settings-draft';

type SignupPolicy = 'open' | 'approval' | 'closed';

const PROXY_NOTE = 'Needs a reverse proxy that sets X-Real-IP.';

/** Who may join a multi-user instance: account sign-ups and guest sessions. */
export function AdminAccessPanel() {
  const { data: session } = useAuthSession();
  const { loaded, draft, update, source, toggle, number, saveBar } = useAdminSettingsDraft('Access settings saved');
  const { data: taskData } = useQuery({
    queryKey: queryKeys.admin(session?.user?.id ?? 'no-session', 'tasks'),
    queryFn: fetchTasks,
    enabled: Boolean(session?.user?.id),
  });

  if (!loaded) return <AdminSettingsSkeleton titles={['Sign-ups', 'Guests']} label="Loading access settings" />;

  const signupPolicy: SignupPolicy = draft.signupPolicy === 'approval' || draft.signupPolicy === 'closed'
    ? draft.signupPolicy
    : 'open';
  const guestCleanupOff = taskData?.tasks.some((task) => task.key === 'expire-anonymous-users' && !task.enabled);

  return (
    <div className="space-y-5">
      <Section title="Sign-ups" variant="group">
        <SettingRow
          label="New account sign-ups"
          icon={<UserPlusIcon />}
          info="Open lets anyone register, Approve holds new accounts until an admin accepts them, and Closed stops registration."
          description="Approval does not verify email ownership."
          meta={source('signupPolicy')}
          stacked
        >
          <SegmentedControl<SignupPolicy>
            value={signupPolicy}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'approval', label: 'Approve' },
              { value: 'closed', label: 'Closed' },
            ]}
            onChange={(value) => update('signupPolicy', value)}
            ariaLabel="New account sign-up policy"
            className="grid-cols-3"
          />
        </SettingRow>
        {signupPolicy !== 'closed' ? toggle({
          key: 'limitNewAccountsPerIp',
          label: 'New accounts per IP',
          icon: <UserPlusIcon />,
          info: `Stops sign-ups from one network once it reaches this count in the period. Existing accounts keep working. ${PROXY_NOTE}`,
        }) : null}
        {signupPolicy !== 'closed' && draft.limitNewAccountsPerIp ? <>
          {number({ key: 'newAccountsPerIp', label: 'Accounts per period', icon: <UserPlusIcon /> })}
          {number({ key: 'newAccountsPerIpDays', label: 'Account period', icon: <HourglassIcon />, unit: 'days' })}
        </> : null}
      </Section>

      <Section title="Guests" variant="group">
        {toggle({
          key: 'allowAnonymousSessions',
          label: 'Guest sessions',
          icon: <UserIcon />,
          info: 'Visitors can use the app without an account and keep their data by signing up later.',
        })}
        {draft.allowAnonymousSessions ? <>
          {number({
            key: 'anonymousUserIdleDays',
            label: 'Guest idle period',
            icon: <HourglassIcon />,
            info: 'Guest accounts idle this long are deleted when the Delete idle guest accounts task is on.',
            description: guestCleanupOff ? (
              <>Guests are never removed while <Link className="underline" href="/app/settings?section=maintenance">Delete idle guest accounts</Link> is off.</>
            ) : undefined,
            unit: 'days',
          })}
          {toggle({
            key: 'limitNewGuestsPerIp',
            label: 'New guests per IP',
            icon: <UserPlusIcon />,
            info: `Stops new guests from one network once it reaches this count within the guest idle period. Existing guests keep working. ${PROXY_NOTE}`,
          })}
          {draft.limitNewGuestsPerIp ? number({
            key: 'newGuestsPerIp',
            label: `Guests per ${String(draft.anonymousUserIdleDays)} days`,
            ariaLabel: 'Guests per idle period',
            icon: <UserPlusIcon />,
          }) : null}
        </> : null}
      </Section>

      {saveBar}
    </div>
  );
}
