'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { formatBytes } from '@/lib/shared/format-bytes';
import { useMaintenanceOperation, type MaintenanceOperation } from '@/hooks/useMaintenanceOperation';

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
  deletionRequestedAt: string | null;
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

async function deleteUsers(userIds: string[]): Promise<MaintenanceOperation> {
  const response = await fetch('/api/admin/users/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<MaintenanceOperation>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
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

function UsersSkeleton() {
  return (
    <div className="animate-pulse divide-y divide-line-soft" aria-label="Loading users" aria-busy="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-3 p-3">
          <div className="h-4 w-4 shrink-0 rounded bg-offbase" />
          <div className="h-8 w-8 shrink-0 rounded-full bg-offbase" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-40 rounded bg-offbase" />
            <div className="h-3 w-56 rounded bg-offbase" />
          </div>
          <div className="hidden h-3 w-20 rounded bg-offbase lg:block" />
          <div className="hidden h-3 w-24 rounded bg-offbase lg:block" />
          <div className="hidden h-6 w-40 rounded-md bg-offbase lg:block" />
        </div>
      ))}
    </div>
  );
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
  const [deletionOperationId, setDeletionOperationId] = useState<string | null>(null);
  const deletionStorageKey = session?.user?.id ? `admin-user-deletion:${session.user.id}` : null;
  useEffect(() => {
    if (deletionStorageKey) setDeletionOperationId(sessionStorage.getItem(deletionStorageKey));
  }, [deletionStorageKey]);
  const trackDeletion = (operation: MaintenanceOperation) => {
    if (deletionStorageKey) sessionStorage.setItem(deletionStorageKey, operation.opId);
    setDeletionOperationId(operation.opId);
  };
  const deletion = useMaintenanceOperation(deletionOperationId, (operation) => {
    if (deletionStorageKey) sessionStorage.removeItem(deletionStorageKey);
    setDeletionOperationId(null);
    if (operation.status === 'failed' || operation.result?.failed) toast.error(operation.result?.summary ?? operation.error?.message ?? 'Deletion failed');
    else toast.success(operation.result?.summary ?? 'Account deletion finished');
    void refreshUsers();
  }, (reason) => {
    // A dropped stream keeps the stored id so a reload reconnects to the job.
    if (reason === 'expired' && deletionStorageKey) sessionStorage.removeItem(deletionStorageKey);
    setDeletionOperationId(null);
    toast.error(reason === 'expired'
      ? 'Cleanup progress has expired. Unfinished accounts remain marked for retry.'
      : 'Lost connection to cleanup progress. Deletion continues; reload to check on it.');
    void refreshUsers();
  });
  const queryKey = useMemo(() => queryKeys.admin(
    session?.user?.id ?? 'no-session',
    `users:${page}:${kind}:${status}:${deferredSearch}`,
  ), [deferredSearch, kind, page, session?.user?.id, status]);

  const usersQuery = useQuery({
    queryKey,
    queryFn: () => fetchUsers({ page, search: deferredSearch, kind, status }),
    enabled: Boolean(session?.user?.id),
    placeholderData: keepPreviousData,
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
    mutationFn: (id: string) => deleteUsers([id]),
    onSuccess: async (operation) => {
      setDeleteTarget(null);
      trackDeletion(operation);
      await refreshUsers();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Unable to delete user'),
  });
  const bulkMutation = useMutation({
    mutationFn: async ({ action, users }: { action: BulkAction; users: ManagedUser[] }) => {
      if (action === 'delete') return { total: users.length, failed: 0, operation: await deleteUsers(users.map((user) => user.id)) };
      const results = await Promise.allSettled(users.map((user) => (
        updateUser(user.id, { accessStatus: action === 'suspend' ? 'suspended' : 'active' })
      )));
      const failed = results.filter((result) => result.status === 'rejected').length;
      return { total: users.length, failed };
    },
    onSuccess: async ({ total, failed, operation }) => {
      setBulkTarget(null);
      setSelectedIds(new Set());
      if (operation) trackDeletion(operation);
      else if (failed === 0) toast.success(`${total} ${total === 1 ? 'user' : 'users'} updated`);
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
  // One deletion job is tracked at a time; other row actions stay available.
  const deletionTracked = Boolean(deletionOperationId);
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
    if (users.length === 0 || bulkBusy || (action === 'delete' && deletionTracked)) return;
    if (action === 'delete' || action === 'suspend') setBulkTarget({ action, users });
    else bulkMutation.mutate({ action, users });
  };
  const changeFilter = <T,>(setter: (value: T) => void, value: T) => {
    setPage(1);
    setter(value);
  };

  return (
    <div className="space-y-4">
      {deletionOperationId ? (
        <p role="status" aria-live="polite" className="rounded-lg border border-line p-3 text-sm text-soft">
          {deletion.progress
            ? `${deletion.progress.phase}: ${deletion.progress.completed} completed · ${deletion.progress.failed} failed`
            : 'Account deletion queued…'}
          {deletion.reconnecting ? ' Reconnecting to progress…' : ' You can leave this page while cleanup continues.'}
        </p>
      ) : null}
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-3 gap-px bg-line-soft lg:grid-cols-6">
          {[
            ['All users', data?.counts.all ?? 0],
            ['Accounts', data?.counts.accounts ?? 0],
            ['Anonymous', data?.counts.anonymous ?? 0],
            ['Awaiting', data?.counts.pending ?? 0],
            ['Suspended', data?.counts.suspended ?? 0],
            ['Admins', data?.counts.admins ?? 0],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 bg-surface-solid px-3 py-2 sm:py-3">
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{label}</p>
              {data
                ? <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground sm:text-xl">{formatCount(Number(value))}</p>
                : <div className="mt-1.5 h-6 w-10 animate-pulse rounded bg-offbase" />}
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-surface-solid p-3">
          <SearchField
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="Search name or email"
            aria-label="Search users"
            className="w-full sm:w-auto sm:min-w-56 sm:flex-1"
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
            className="w-full grid-cols-3 sm:w-auto"
          />
          <SegmentedControl<UserStatus>
            value={status}
            onChange={(value) => changeFilter(setStatus, value)}
            options={[
              { value: 'all', label: 'Any' },
              { value: 'pending', label: 'Pending' },
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
            ]}
            ariaLabel="Access status"
            className="w-full grid-flow-col auto-cols-auto sm:w-auto"
          />
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
              <Button size="xs" variant="ghost" className="text-danger hover:bg-danger-wash hover:text-danger" disabled={bulkBusy || deletionTracked || eligible.delete.length === 0} onClick={() => runBulk('delete')}>Delete{eligible.delete.length ? ` (${eligible.delete.length})` : ''}</Button>
            </div>
          </div>
        ) : null}

        {usersQuery.isPending ? (
          <UsersSkeleton />
        ) : usersQuery.error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-danger">{usersQuery.error instanceof Error ? usersQuery.error.message : 'Unable to load users'}</p>
            <Button className="mt-3" size="sm" onClick={() => void usersQuery.refetch()}>Retry</Button>
          </div>
        ) : data?.users.length === 0 ? (
          <p className="p-10 text-center text-sm text-soft">No users match these filters</p>
        ) : (
          <div className={`transition-opacity duration-base ${usersQuery.isPlaceholderData ? 'opacity-60' : ''}`}>
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
              const busy = bulkBusy || updateMutation.isPending || deleteMutation.isPending;
              return (
                <article key={user.id} className={selectedIds.has(user.id) ? 'group bg-accent-wash' : 'group'}>
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
                              <Badge tone={user.deletionRequestedAt ? 'muted' : statusTone(user.accessStatus)}>{user.deletionRequestedAt ? 'Deletion pending' : user.accessStatus}</Badge>
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-soft">{user.isAnonymous ? user.id : user.email}</span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] tabular-nums text-faint lg:hidden">
                              {formatCount(user.documentCount)} docs · {formatBytes(user.documentBytes)} · {formatCount(user.usage.ttsCharacters)} chars
                            </span>
                          </span>
                        </div>
                      </button>
                    </div>

                    <span className="hidden text-right font-mono text-xs font-medium tabular-nums text-foreground lg:block">{formatCount(user.documentCount)} · {formatBytes(user.documentBytes)}</span>
                    <span className="hidden text-right font-mono text-xs font-medium tabular-nums text-foreground lg:block">{formatCount(user.usage.ttsCharacters)} chars</span>

                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-16 empty:hidden lg:mt-0 lg:justify-end lg:pl-0">
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
                      {!isSelf ? <Button size="xs" variant="ghost" className="text-danger hover:bg-danger-wash hover:text-danger" disabled={busy || deletionTracked} onClick={() => setDeleteTarget(user)}>Delete</Button> : null}
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
          ? `Permanently delete ${bulkTarget.users.length} selected ${bulkTarget.users.length === 1 ? 'user' : 'users'} and all owned data? Their sessions end immediately. Cleanup continues in the background.`
          : `Suspend ${bulkTarget?.users.length} selected ${bulkTarget && bulkTarget.users.length === 1 ? 'account' : 'accounts'}? Their active sessions will be revoked.`}
        confirmText={bulkMutation.isPending ? 'Working…' : bulkTarget?.action === 'delete' ? 'Delete users' : 'Suspend users'}
        isDangerous
      />
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget && !deleteMutation.isPending) deleteMutation.mutate(deleteTarget.id); }}
        title={deleteTarget?.isAnonymous ? 'Delete anonymous session?' : 'Delete user account?'}
        message={`Permanently delete ${deleteTarget?.isAnonymous ? 'this anonymous session' : deleteTarget?.email ?? 'this user'} and all owned data? Their sessions end immediately. Cleanup continues in the background.`}
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
