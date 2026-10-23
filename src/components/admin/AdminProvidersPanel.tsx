'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { DotsHorizontalIcon, PlusIcon } from '@/components/icons/Icons';
import { isLocalTtsProviderType, KOKORO_LOCAL_MODEL } from '@openreader/tts/provider-catalog';
import { defaultModelForProviderType } from '@openreader/tts/provider-policy';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  Badge,
  IconButton,
  MenuActionItem,
  MenuItemsSurface,
  MenuRoot,
  MenuTransition,
  MenuTrigger,
  Section,
} from '@/components/ui';
import { ProviderLogo } from '@/components/providers/provider-brands';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { computeLocationPhrase } from '@/lib/shared/install-profile';
import { LocalModelCard } from './LocalModelCard';
import {
  type AdminProviderMasked,
  ProviderEditorDialog,
  type ProviderEditorTarget,
  uniqueSlug,
} from './ProviderEditorDialog';

async function fetchDefaultProviderSlug(): Promise<string> {
  const res = await fetch('/api/admin/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { values?: { defaultTtsProvider?: unknown } };
  return typeof data.values?.defaultTtsProvider === 'string' ? data.values.defaultTtsProvider : '';
}

async function readError(res: Response): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(data.error || `HTTP ${res.status}`);
}

async function patchDefaultProviderSlug(slug: string): Promise<void> {
  const res = await fetch('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: { defaultTtsProvider: slug } }),
  });
  if (res.status === 200 || res.status === 204) return;
  if (res.status === 207) {
    // Multi-status: the request succeeded for some keys but failed for others.
    // Only treat it as success when the defaultTtsProvider field itself was
    // accepted (no matching entry in the errors array).
    const payload = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ key?: string; message?: string }>;
    };
    const failure = payload.errors?.find((entry) => entry?.key === 'defaultTtsProvider');
    if (failure) {
      throw new Error(failure.message || 'Failed to update default provider');
    }
    return;
  }
  throw new Error(`HTTP ${res.status}`);
}

async function patchProviderEnabled(input: { id: string; enabled: boolean }): Promise<void> {
  const res = await fetch(`/api/admin/providers/${input.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: input.enabled }),
  });
  if (!res.ok) throw await readError(res);
}

/**
 * Offering a local model turns its shared provider on, creating it the first
 * time; withdrawing it turns every provider of that model off.
 */
async function setLocalModelOffered(input: {
  offered: boolean;
  rows: AdminProviderMasked[];
  takenSlugs: ReadonlySet<string>;
}): Promise<void> {
  if (!input.offered) {
    await Promise.all(input.rows.filter((row) => row.enabled).map((row) => patchProviderEnabled({ id: row.id, enabled: false })));
    return;
  }
  if (input.rows.length > 0) {
    await patchProviderEnabled({ id: input.rows[0].id, enabled: true });
    return;
  }
  const res = await fetch('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: uniqueSlug('kokoro', input.takenSlugs),
      displayName: 'Kokoro',
      providerType: 'kokoro-local',
      defaultModel: KOKORO_LOCAL_MODEL,
      enabled: true,
    }),
  });
  if (!res.ok) throw await readError(res);
}

function baseUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function truncateModelLabel(value: string, maxLength = 56): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function fetchAdminProviders(): Promise<AdminProviderMasked[]> {
  const res = await fetch('/api/admin/providers');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { providers: AdminProviderMasked[] };
  return data.providers;
}

async function deleteAdminProvider(id: string): Promise<void> {
  const res = await fetch(`/api/admin/providers/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res);
}

export function AdminProvidersPanel() {
  const { computeLocation } = useRuntimeConfig();
  const where = computeLocationPhrase(computeLocation);
  const { data: session } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const adminProvidersQueryKey = queryKeys.admin(sessionId, 'providers');
  const adminSettingsQueryKey = queryKeys.admin(sessionId, 'settings');
  const adminDefaultProviderQueryKey = queryKeys.admin(sessionId, 'default-provider');
  const sharedProvidersQueryKey = queryKeys.sharedProviders(sessionId);
  const queryClient = useQueryClient();
  const [editorTarget, setEditorTarget] = useState<ProviderEditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminProviderMasked | null>(null);

  const { data: providers = [], isPending: isLoading, error } = useQuery({
    queryKey: adminProvidersQueryKey,
    queryFn: fetchAdminProviders,
  });
  const {
    data: defaultProviderSlug = '',
    error: defaultProviderError,
  } = useQuery({
    queryKey: adminDefaultProviderQueryKey,
    queryFn: fetchDefaultProviderSlug,
  });

  useEffect(() => {
    if (!error) return;
    console.error('[AdminProvidersPanel] load failed:', error);
    toast.error('Failed to load admin providers');
  }, [error]);
  useEffect(() => {
    if (!defaultProviderError) return;
    console.error('[AdminProvidersPanel] default provider load failed:', defaultProviderError);
    toast.error('Failed to load default provider');
  }, [defaultProviderError]);

  const refreshProviders = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: adminProvidersQueryKey }),
    queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey }),
    queryClient.invalidateQueries({ queryKey: adminDefaultProviderQueryKey }),
    queryClient.invalidateQueries({ queryKey: sharedProvidersQueryKey }),
  ]);
  const onMutationError = (action: string, fallback: string) => (mutationError: unknown) => {
    console.error(`[AdminProvidersPanel] ${action} failed:`, mutationError);
    toast.error((mutationError as Error).message || fallback);
  };

  const deleteMutation = useMutation({
    mutationFn: deleteAdminProvider,
    onSuccess: async () => {
      toast.success('Provider deleted');
      await refreshProviders();
    },
    onError: onMutationError('delete', 'Delete failed'),
  });
  const toggleEnabledMutation = useMutation({
    mutationFn: patchProviderEnabled,
    onSuccess: async (_data, vars) => {
      toast.success(vars.enabled ? 'Provider enabled' : 'Provider disabled');
      await refreshProviders();
    },
    onError: onMutationError('toggle enabled', 'Update failed'),
  });
  const localOfferMutation = useMutation({
    mutationFn: setLocalModelOffered,
    onSuccess: async (_data, vars) => {
      toast.success(vars.offered ? 'Kokoro is offered to users' : 'Kokoro is no longer offered');
      await refreshProviders();
    },
    onError: onMutationError('local model toggle', 'Update failed'),
  });
  const setDefaultMutation = useMutation({
    mutationFn: patchDefaultProviderSlug,
    onSuccess: async () => {
      toast.success('Default provider updated');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminDefaultProviderQueryKey }),
      ]);
    },
    onError: onMutationError('set default', 'Failed to set default'),
  });

  const takenSlugs = useMemo(() => new Set(providers.map((p) => p.slug)), [providers]);
  const localRows = providers.filter((p) => p.providerType === 'kokoro-local');
  const externalProviders = providers.filter((p) => !isLocalTtsProviderType(p.providerType));
  const localOffered = localRows.some((row) => row.enabled);
  const localDefault = localRows.some((row) => row.slug === defaultProviderSlug);

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target && !deleteMutation.isPending) deleteMutation.mutate(target.id);
  };
  const toggleEnabled = (provider: AdminProviderMasked) => {
    if (toggleEnabledMutation.isPending) return;
    toggleEnabledMutation.mutate({ id: provider.id, enabled: !provider.enabled });
  };
  const setDefault = (slug: string) => {
    if (setDefaultMutation.isPending) return;
    setDefaultMutation.mutate(slug);
  };

  const rowActionsDisabled = deleteMutation.isPending || toggleEnabledMutation.isPending || setDefaultMutation.isPending;

  return (
    <div className="space-y-6">
      <Section title="Local models" variant="group" subtitle={`Run ${where} with no account or key.`}>
        {isLoading ? (
          <ProvidersListSkeleton rows={1} />
        ) : (
          <LocalModelCard
            where={where}
            offered={localOffered}
            isDefault={localDefault}
            busy={localOfferMutation.isPending || setDefaultMutation.isPending}
            onOfferChange={(offered) => {
              if (!localOfferMutation.isPending) localOfferMutation.mutate({ offered, rows: localRows, takenSlugs });
            }}
            onSetDefault={() => {
              const row = localRows.find((candidate) => candidate.enabled);
              if (row) setDefault(row.slug);
            }}
          />
        )}
      </Section>

      <Section title="External providers" variant="group">
        {isLoading ? (
          <ProvidersListSkeleton rows={2} />
        ) : externalProviders.length === 0 ? (
          <p className="text-sm text-soft">No external providers yet</p>
        ) : (
          externalProviders.map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              <span className={p.enabled ? undefined : 'opacity-50'}>
                <ProviderLogo providerType={p.providerType} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={`truncate text-sm font-medium ${p.enabled ? 'text-foreground' : 'text-soft'}`}>{p.displayName}</span>
                  {defaultProviderSlug === p.slug && <Badge tone="accent">Default</Badge>}
                  {!p.enabled && <Badge tone="muted">Disabled</Badge>}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-soft" title={p.defaultModel ?? undefined}>
                  {truncateModelLabel(p.defaultModel ?? defaultModelForProviderType(p.providerType))}
                  {p.baseUrl ? ` · ${baseUrlHost(p.baseUrl)}` : ''}
                </div>
              </div>
              <MenuRoot as="div" className="relative shrink-0">
                <MenuTrigger
                  as={IconButton}
                  tone="surface"
                  size="sm"
                  title="Provider actions"
                  aria-label={`Actions for ${p.displayName}`}
                  disabled={rowActionsDisabled}
                >
                  <DotsHorizontalIcon className="h-3 w-4" />
                </MenuTrigger>
                <MenuTransition>
                  <MenuItemsSurface
                    anchor="bottom end"
                    className="z-50 mt-2 min-w-[170px] bg-base focus:outline-none"
                  >
                    <MenuActionItem onClick={() => setEditorTarget({ kind: 'edit', provider: p })}>
                      Edit
                    </MenuActionItem>
                    <MenuActionItem
                      onClick={() => setDefault(p.slug)}
                      disabled={!p.enabled || defaultProviderSlug === p.slug}
                    >
                      Set as default
                    </MenuActionItem>
                    <MenuActionItem onClick={() => toggleEnabled(p)}>
                      {p.enabled ? 'Disable' : 'Enable'}
                    </MenuActionItem>
                    <MenuActionItem tone="danger" onClick={() => setDeleteTarget(p)}>
                      Delete
                    </MenuActionItem>
                  </MenuItemsSurface>
                </MenuTransition>
              </MenuRoot>
            </div>
          ))
        )}
        {/* Shown once the list settles, so it never moves under the pointer. */}
        {isLoading ? null : (
          <button
            type="button"
            onClick={() => setEditorTarget({ kind: 'new' })}
            className="flex w-full items-center gap-2 rounded-b-lg text-sm font-medium text-accent transition-colors duration-base hover:bg-accent-wash focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Add provider
          </button>
        )}
      </Section>

      <ProviderEditorDialog
        target={editorTarget}
        takenSlugs={takenSlugs}
        onClose={() => setEditorTarget(null)}
        onSaved={async () => {
          await refreshProviders();
        }}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete provider?"
        message={`Users who selected ${deleteTarget?.displayName ?? 'this provider'} lose access until they switch.`}
        confirmText="Delete"
        isDangerous
      />
    </div>
  );
}

function ProvidersListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="animate-pulse space-y-3" aria-label="Loading providers" aria-busy="true">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-3">
          <div className="h-8 w-8 shrink-0 rounded-md bg-offbase" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-36 rounded bg-offbase" />
            <div className="h-3 w-56 rounded bg-offbase" />
          </div>
        </div>
      ))}
    </div>
  );
}
