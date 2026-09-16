'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingSpinner } from '@/components/Spinner';
import {
  Badge,
  Button,
  Checkbox,
  SearchField,
  SegmentedControl,
  Switch,
} from '@/components/ui';
import { useAuthSession } from '@/hooks/useAuthSession';
import { queryKeys } from '@/lib/client/query-keys';

type UserAccessStatus = 'active' | 'pending' | 'suspended';
type UserKind = 'all' | 'account' | 'anonymous';
type UserStatus = 'all' | UserAccessStatus;
type BulkAction = 'approve' | 'suspend' | 'restore' | 'delete';

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  isAdmin: boolean;
  adminSource: 'bootstrap' | 'managed' | 'none';
  accessStatus: UserAccessStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  sessionCount: number;
  documentCount: number;
  documentBytes: number;
  usage: { ttsCharacters: number; inputBytes: number; files: number };
}

interface UsersResponse {
  users: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
  counts: {
    all: number;
    accounts: number;
    anonymous: number;
    pending: number;
    suspended: number;
    admins: number;
  };
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error || `Request failed (${response.status})`);
}

async function fetchUsers(input: {
  page: number;
  search: string;
  kind: UserKind;
  status: UserStatus;
}): Promise<UsersResponse> {
  const params = new URLSearchParams({
    page: String(input.page),
    pageSize: '25',
    search: input.search,
    kind: input.kind,
    status: input.status,
  });
  const response = await fetch(`/api/admin/users?${params}`);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<UsersResponse>;
}

async function updateUser(id: string, changes: Partial<Pick<ManagedUser, 'isAdmin' | 'accessStatus'>>): Promise<void> {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw await responseError(response);
}

async function deleteUser(id: string): Promise<void> {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function formatBytes(value: number): string {
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** power)).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function statusTone(status: UserAccessStatus): 'accent' | 'muted' | 'danger' {
  if (status === 'active') return 'accent';
  if (status === 'suspended') return 'danger';
  return 'muted';
}

export function AdminUsersPanel() {
  const { data: session } = useAuthSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [kind, setKind] = useState<UserKind>('all');
  const [status, setStatus] = useState<UserStatus>('all');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [roleTarget, setRoleTarget] = useState<{ user: ManagedUser; grant: boolean } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkTarget, setBulkTarget] = useState<{ action: BulkAction; users: ManagedUser[] } | null>(null);
  const queryKey = useMemo(() => queryKeys.admin(
    session?.user?.id ?? 'no-session',
    `users:${page}:${kind}:${status}:${deferredSearch}`,
  ), [deferredSearch, kind, page, session?.user?.id, status]);

  const usersQuery = useQuery({
    queryKey,
    queryFn: () => fetchUsers({ page, search: deferredSearch, kind, status }),
    enabled: Boolean(session?.user?.id),
  });
  const refreshUsers = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.adminRoot(session?.user?.id ?? 'no-session') });
  };
  const updateMutation = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Partial<Pick<ManagedUser, 'isAdmin' | 'accessStatus'>> }) => updateUser(id, changes),
    onSuccess: async () => {
      toast.success('User updated');
      await refreshUsers();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to update user'),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: async () => {
      setDeleteTarget(null);
      toast.success('User and owned data deleted');
      await refreshUsers();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to delete user'),
  });
  const bulkMutation = useMutation({
    mutationFn: async ({ action, users }: { action: BulkAction; users: ManagedUser[] }) => {
      const results = await Promise.allSettled(users.map((user) => (
        action === 'delete'
          ? deleteUser(user.id)
          : updateUser(user.id, { accessStatus: action === 'suspend' ? 'suspended' : 'active' })
      )));
      const failed = results.filter((result) => result.status === 'rejected').length;
      return { total: users.length, failed };
    },
    onSuccess: async ({ total, failed }) => {
      setBulkTarget(null);
      setSelectedIds(new Set());
      if (failed === 0) toast.success(`${total} ${total === 1 ? 'user' : 'users'} updated`);
      else toast.error(`${total - failed} of ${total} updated · ${failed} failed`);
      await refreshUsers();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Bulk action failed'),
  });

  const data = usersQuery.data;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 25)));
  // Shared column template so the header and every row align on the same grid.
  const columns = 'lg:grid lg:grid-cols-[minmax(0,1.6fr)_8rem_9rem_15rem] lg:items-center lg:gap-3';

  // Selection is scoped to the visible page; navigating or refiltering clears it
  // so a bulk action can never touch a row the admin cannot currently see.
  const selfId = session?.user?.id;
  const pageUsers = data?.users ?? [];
  const selectableUsers = pageUsers.filter((user) => user.id !== selfId);
  const selectedUsers = pageUsers.filter((user) => selectedIds.has(user.id));
  const allSelected = selectableUsers.length > 0 && selectableUsers.every((user) => selectedIds.has(user.id));
  const someSelected = selectedUsers.length > 0 && !allSelected;
  const bulkBusy = bulkMutation.isPending;
  const eligible: Record<BulkAction, ManagedUser[]> = {
    approve: selectedUsers.filter((user) => !user.isAnonymous && user.accessStatus === 'pending'),
    restore: selectedUsers.filter((user) => !user.isAnonymous && user.accessStatus === 'suspended'),
    suspend: selectedUsers.filter((user) => !user.isAnonymous && user.accessStatus === 'active'),
    delete: selectedUsers,
  };

  useEffect(() => { setSelectedIds(new Set()); }, [page, kind, status, deferredSearch]);

  const toggleOne = (id: string, checked: boolean) => setSelectedIds((current) => {
    const next = new Set(current);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });
  const toggleAll = (checked: boolean) => setSelectedIds(checked ? new Set(selectableUsers.map((user) => user.id)) : new Set());
  const runBulk = (action: BulkAction) => {
    const users = eligible[action];
    if (users.length === 0 || bulkBusy) return;
    if (action === 'delete' || action === 'suspend') setBulkTarget({ action, users });
    else bulkMutation.mutate({ action, users });
  };
  const changeFilter = <T,>(setter: (value: T) => void, value: T) => {
    setPage(1);
    setter(value);
  };

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-2 divide-x divide-y divide-line-soft sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          {[
            ['All users', data?.counts.all ?? 0],
            ['Accounts', data?.counts.accounts ?? 0],
            ['Anonymous', data?.counts.anonymous ?? 0],
            ['Awaiting', data?.counts.pending ?? 0],
            ['Suspended', data?.counts.suspended ?? 0],
            ['Admins', data?.counts.admins ?? 0],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 bg-surface-solid px-3 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{label}</p>
              <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">{formatCount(Number(value))}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-col gap-3 border-b border-line-soft bg-surface-solid p-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Directory</h3>
            <p className="mt-0.5 text-xs text-soft">Accounts, anonymous sessions, storage, and metered compute usage when limits are enabled.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchField
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              placeholder="Search name or email"
              aria-label="Search users"
              className="w-full sm:w-56"
            />
            <SegmentedControl<UserKind>
              value={kind}
              onChange={(value) => changeFilter(setKind, value)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'account', label: 'Accounts' },
                { value: 'anonymous', label: 'Anon' },
              ]}
              ariaLabel="User kind"
              className="grid-cols-3"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b border-line-soft px-3 py-2">
          {(['all', 'pending', 'active', 'suspended'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => changeFilter(setStatus, value)}
              aria-pressed={status === value}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${status === value ? 'bg-accent-wash text-accent' : 'text-soft hover:bg-surface-sunken hover:text-foreground'}`}
            >
              {value === 'all' ? 'Any status' : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
          {usersQuery.isFetching ? <LoadingSpinner className="ml-auto h-3.5 w-3.5 text-accent" /> : null}
        </div>

        {selectedUsers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-accent-wash px-3 py-2">
            <span className="text-xs font-semibold text-foreground">{selectedUsers.length} selected</span>
            <Button size="xs" variant="ghost" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>Clear</Button>
            {bulkBusy ? <LoadingSpinner className="h-3.5 w-3.5 text-accent" /> : null}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" disabled={bulkBusy || eligible.approve.length === 0} onClick={() => runBulk('approve')}>Approve{eligible.approve.length ? ` (${eligible.approve.length})` : ''}</Button>
              <Button size="xs" variant="outline" disabled={bulkBusy || eligible.restore.length === 0} onClick={() => runBulk('restore')}>Restore{eligible.restore.length ? ` (${eligible.restore.length})` : ''}</Button>
              <Button size="xs" variant="outline" disabled={bulkBusy || eligible.suspend.length === 0} onClick={() => runBulk('suspend')}>Suspend{eligible.suspend.length ? ` (${eligible.suspend.length})` : ''}</Button>
              <Button size="xs" variant="ghost" className="text-danger hover:bg-danger-wash hover:text-danger" disabled={bulkBusy || eligible.delete.length === 0} onClick={() => runBulk('delete')}>Delete{eligible.delete.length ? ` (${eligible.delete.length})` : ''}</Button>
            </div>
          </div>
        ) : null}

        {usersQuery.isPending ? (
          <div className="grid min-h-56 place-items-center"><LoadingSpinner className="h-6 w-6 text-accent" /></div>
        ) : usersQuery.error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-danger">{usersQuery.error instanceof Error ? usersQuery.error.message : 'Unable to load users'}</p>
            <Button className="mt-3" size="sm" onClick={() => void usersQuery.refetch()}>Retry</Button>
          </div>
        ) : data?.users.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-foreground">No users match these filters</p>
            <p className="mt-1 text-xs text-soft">Try a broader search or status.</p>
          </div>
        ) : (
          <div>
            <div className={`hidden border-b border-line-soft bg-surface-solid px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint ${columns}`}>
              <span className="flex items-center gap-2">
                <Checkbox
                  ref={(node) => { if (node) node.indeterminate = someSelected; }}
                  checked={allSelected}
                  disabled={selectableUsers.length === 0}
                  onChange={(event) => toggleAll(event.target.checked)}
                  aria-label="Select all users on this page"
                />
                User
              </span>
              <span className="text-right">Documents</span>
              <span className="text-right">TTS usage</span>
              <span className="text-right">Manage</span>
            </div>
            <div className="divide-y divide-line-soft">
            {data?.users.map((user) => {
              const isSelf = user.id === session?.user?.id;
              const expanded = expandedId === user.id;
              const busy = updateMutation.isPending || deleteMutation.isPending;
              return (
                <article key={user.id} className={selectedIds.has(user.id) ? 'group bg-accent-wash/40' : 'group'}>
                  <div className={`p-3 ${columns}`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={selectedIds.has(user.id)}
                        disabled={isSelf}
                        onChange={(event) => toggleOne(user.id, event.target.checked)}
                        aria-label={`Select ${user.isAnonymous ? user.id : user.email}`}
                        className="shrink-0"
                      />
                      <button type="button" onClick={() => setExpandedId(expanded ? null : user.id)} className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-xs font-bold ${user.isAnonymous ? 'bg-surface-sunken text-soft' : 'bg-accent-wash text-accent'}`}>
                            {user.isAnonymous ? 'AN' : (user.name || user.email).slice(0, 2).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="block truncate text-sm font-medium text-foreground">{user.isAnonymous ? 'Anonymous session' : user.name || 'Unnamed account'}</span>
                              {isSelf ? <Badge tone="foreground">You</Badge> : null}
                              {user.isAdmin ? <Badge tone="accent">Admin</Badge> : null}
                              <Badge tone={statusTone(user.accessStatus)}>{user.accessStatus}</Badge>
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-soft">{user.isAnonymous ? user.id : user.email}</span>
                          </span>
                        </div>
                      </button>
                    </div>

                    <div className="mt-2 flex items-baseline justify-between gap-2 text-xs lg:mt-0 lg:block lg:text-right">
                      <span className="text-soft lg:hidden">Documents</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">{formatCount(user.documentCount)} · {formatBytes(user.documentBytes)}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2 text-xs lg:mt-0 lg:block lg:text-right">
                      <span className="text-soft lg:hidden">TTS usage</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">{formatCount(user.usage.ttsCharacters)} chars</span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 lg:mt-0 lg:justify-end">
                      {!user.isAnonymous ? (
                        <label className="flex items-center gap-1.5 text-xs text-soft">
                          Admin
                          <Switch
                            size="sm"
                            checked={user.isAdmin}
                            disabled={busy || isSelf || (!user.isAdmin && user.accessStatus !== 'active')}
                            onChange={(isAdmin) => setRoleTarget({ user, grant: isAdmin })}
                            ariaLabel={`Administrator access for ${user.email}`}
                          />
                        </label>
                      ) : null}
                      {!user.isAnonymous && user.accessStatus === 'pending' ? (
                        <Button size="xs" variant="primary" disabled={busy} onClick={() => updateMutation.mutate({ id: user.id, changes: { accessStatus: 'active' } })}>Approve</Button>
                      ) : null}
                      {!user.isAnonymous && user.accessStatus !== 'pending' && !isSelf ? (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => updateMutation.mutate({ id: user.id, changes: { accessStatus: user.accessStatus === 'suspended' ? 'active' : 'suspended' } })}>
                          {user.accessStatus === 'suspended' ? 'Restore' : 'Suspend'}
                        </Button>
                      ) : null}
                      {!isSelf ? <Button size="xs" variant="ghost" className="text-danger hover:bg-danger-wash hover:text-danger" disabled={busy} onClick={() => setDeleteTarget(user)}>Delete</Button> : null}
                    </div>
                  </div>

                  {expanded ? (
                    <div className="grid gap-3 border-t border-line-soft bg-surface-sunken px-3 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                      <Detail label="Created" value={formatDate(user.createdAt)} />
                      <Detail label="Updated" value={formatDate(user.updatedAt)} />
                      <Detail label="Last session activity" value={formatDate(user.lastActiveAt)} />
                      <Detail label="Sessions" value={formatCount(user.sessionCount)} />
                      <Detail label="Email" value={user.isAnonymous ? 'Not applicable' : user.emailVerified ? 'Verified' : 'Not verified'} />
                      <Detail label="Processed input" value={formatBytes(user.usage.inputBytes)} />
                      <Detail label="Processed files" value={formatCount(user.usage.files)} />
                      <Detail label="User ID" value={user.id} mono />
                      <Detail label="Admin source" value={user.adminSource === 'bootstrap' && !user.isAdmin ? 'Initial setup · password change required' : user.isAdmin ? 'Managed grant' : 'None'} />
                    </div>
                  ) : null}
                </article>
              );
            })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line-soft bg-surface-solid px-3 py-2">
          <p className="text-xs text-soft">{formatCount(data?.total ?? 0)} matching users</p>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" disabled={page <= 1 || usersQuery.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
            <span className="font-mono text-[11px] tabular-nums text-soft">{page} / {totalPages}</span>
            <Button size="xs" variant="outline" disabled={page >= totalPages || usersQuery.isFetching} onClick={() => setPage((value) => value + 1)}>Next</Button>
          </div>
        </div>
      </section>

      <ConfirmDialog
        isOpen={Boolean(roleTarget)}
        onClose={() => setRoleTarget(null)}
        onConfirm={() => {
          if (!roleTarget || updateMutation.isPending) return;
          updateMutation.mutate({ id: roleTarget.user.id, changes: { isAdmin: roleTarget.grant } }, {
            onSuccess: () => setRoleTarget(null),
          });
        }}
        title={roleTarget?.grant ? 'Grant administrator access?' : 'Remove administrator access?'}
        message={roleTarget?.grant
          ? `Administrators can manage users, credentials, and site settings. Grant this access to ${roleTarget?.user.email}?`
          : `Remove administrator access from ${roleTarget?.user.email}? Their active sessions will be revoked.`}
        confirmText={roleTarget?.grant ? 'Grant admin' : 'Remove admin'}
        isDangerous
      />
      <ConfirmDialog
        isOpen={Boolean(bulkTarget)}
        onClose={() => setBulkTarget(null)}
        onConfirm={() => { if (bulkTarget && !bulkMutation.isPending) bulkMutation.mutate(bulkTarget); }}
        title={bulkTarget?.action === 'delete' ? 'Delete selected users?' : 'Suspend selected users?'}
        message={bulkTarget?.action === 'delete'
          ? `Permanently delete ${bulkTarget.users.length} selected ${bulkTarget.users.length === 1 ? 'user' : 'users'} and all owned data? Storage cleanup must succeed for each before its database account is removed.`
          : `Suspend ${bulkTarget?.users.length} selected ${bulkTarget && bulkTarget.users.length === 1 ? 'account' : 'accounts'}? Their active sessions will be revoked.`}
        confirmText={bulkMutation.isPending ? 'Working…' : bulkTarget?.action === 'delete' ? 'Delete users' : 'Suspend users'}
        isDangerous
      />
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget && !deleteMutation.isPending) deleteMutation.mutate(deleteTarget.id); }}
        title={deleteTarget?.isAnonymous ? 'Delete anonymous session?' : 'Delete user account?'}
        message={`Permanently delete ${deleteTarget?.isAnonymous ? 'this anonymous session' : deleteTarget?.email ?? 'this user'} and all owned data? Storage cleanup must succeed before the database account is removed.`}
        confirmText={deleteMutation.isPending ? 'Deleting…' : 'Delete user'}
        isDangerous
      />
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">{label}</p>
      <p className={`mt-0.5 break-all text-foreground ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</p>
    </div>
  );
}
