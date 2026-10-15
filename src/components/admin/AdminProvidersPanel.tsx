'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { DotsHorizontalIcon, PlusIcon } from '@/components/icons/Icons';
import { providerSupportsCustomModel, resolveProviderModels, type TtsModelDefinition, type TtsProviderId, type TtsProviderType } from '@openreader/tts/provider-catalog';
import { defaultBaseUrlForProviderType, defaultModelForProviderType, resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  Badge,
  type BadgeTone,
  Field,
  ModalFrame,
  ModalTitle,
  ToggleRow,
  Select,
  SelectOptionDetail,
  Button,
  IconButton,
  Input,
  Textarea,
  MenuItemsSurface,
  MenuActionItem,
  MenuRoot,
  MenuTrigger,
  MenuTransition,
} from '@/components/ui';
import { queryKeys } from '@/lib/client/query-keys';
import type { ProviderCheckItem, ProviderCheckStatus } from '@/lib/shared/provider-check';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { LocalVoicesCard } from './LocalVoicesCard';

type ProviderType = TtsProviderId;

interface AdminProviderMasked {
  id: string;
  slug: string;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string | null;
  apiKeyMask: string;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const PROVIDER_TYPE_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: 'custom-openai', label: 'Custom OpenAI-like' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepinfra', label: 'Deepinfra' },
  { value: 'replicate', label: 'Replicate' },
  { value: 'speech-sdk', label: 'Speech SDK' },
  { value: 'kokoro-local', label: 'Kokoro (on the compute worker)' },
];

/** On desktop the compute worker is this machine. */
const DESKTOP_PROVIDER_TYPE_OPTIONS = PROVIDER_TYPE_OPTIONS.map((option) => (
  option.value === 'kokoro-local' ? { ...option, label: 'Kokoro (on this device)' } : option
));

interface FormState {
  slug: string;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  defaultInstructions: string;
  enabled: boolean;
}

const providerDefaultModel = defaultModelForProviderType;
async function fetchDefaultProviderSlug(): Promise<string> {
  const res = await fetch('/api/admin/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { values?: { defaultTtsProvider?: unknown } };
  return typeof data.values?.defaultTtsProvider === 'string' ? data.values.defaultTtsProvider : '';
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
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

function createEmptyForm(): FormState {
  return {
    slug: '',
    displayName: '',
    providerType: 'custom-openai',
    baseUrl: '',
    apiKey: '',
    defaultModel: providerDefaultModel('custom-openai'),
    defaultInstructions: '',
    enabled: true,
  };
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

async function upsertAdminProvider(input: {
  editingId: string | null;
  form: FormState;
}): Promise<void> {
  const isNew = input.editingId === '__new';
  const body = {
    slug: input.form.slug.trim(),
    displayName: input.form.displayName.trim(),
    providerType: input.form.providerType,
    baseUrl: input.form.baseUrl.trim() || null,
    ...(input.form.apiKey.length > 0 ? { apiKey: input.form.apiKey } : {}),
    defaultModel: input.form.defaultModel.trim() || null,
    defaultInstructions: input.form.defaultInstructions.trim() || null,
    enabled: input.form.enabled,
  };
  const url = isNew ? '/api/admin/providers' : `/api/admin/providers/${input.editingId}`;
  const res = await fetch(url, {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

const CHECK_BADGE: Record<ProviderCheckStatus, { tone: BadgeTone; label: string }> = {
  ok: { tone: 'accent', label: 'OK' },
  warn: { tone: 'foreground', label: 'Check' },
  error: { tone: 'danger', label: 'Fix' },
  skipped: { tone: 'muted', label: 'Skipped' },
};

async function checkAdminProvider(input: {
  editingId: string | null;
  form: FormState;
}): Promise<ProviderCheckItem[]> {
  const res = await fetch('/api/admin/providers/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(input.editingId && input.editingId !== '__new' ? { providerId: input.editingId } : {}),
      providerType: input.form.providerType,
      baseUrl: input.form.baseUrl.trim(),
      apiKey: input.form.apiKey,
      defaultModel: input.form.defaultModel.trim(),
      defaultInstructions: input.form.defaultInstructions.trim(),
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return ((await res.json()) as { checks: ProviderCheckItem[] }).checks;
}

async function deleteAdminProvider(id: string): Promise<void> {
  const res = await fetch(`/api/admin/providers/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

export function AdminProvidersPanel() {
  const onDevice = useRuntimeConfig().installProfile === 'desktop';
  const providerTypeOptions = onDevice ? DESKTOP_PROVIDER_TYPE_OPTIONS : PROVIDER_TYPE_OPTIONS;
  const { data: session } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const adminProvidersQueryKey = queryKeys.admin(sessionId, 'providers');
  const adminSettingsQueryKey = queryKeys.admin(sessionId, 'settings');
  const adminDefaultProviderQueryKey = queryKeys.admin(sessionId, 'default-provider');
  const sharedProvidersQueryKey = queryKeys.sharedProviders(sessionId);
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => createEmptyForm());
  const [customModelInput, setCustomModelInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AdminProviderMasked | null>(null);
  // Results belong to the exact form they checked; any edit hides them.
  const [checkResult, setCheckResult] = useState<{ key: string; items: ProviderCheckItem[] } | null>(null);
  const checkKey = JSON.stringify({ editingId, form });

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

  const saveMutation = useMutation({
    mutationFn: upsertAdminProvider,
    onSuccess: async (_data, variables) => {
      toast.success(variables.editingId === '__new' ? 'Provider created' : 'Provider updated');
      cancelEdit();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminProvidersQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminDefaultProviderQueryKey }),
        queryClient.invalidateQueries({ queryKey: sharedProvidersQueryKey }),
      ]);
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] save failed:', mutationError);
      toast.error((mutationError as Error).message || 'Save failed');
    },
  });

  const checkMutation = useMutation({
    mutationFn: checkAdminProvider,
    onSuccess: (items, variables) => {
      setCheckResult({ key: JSON.stringify(variables), items });
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] check failed:', mutationError);
      toast.error((mutationError as Error).message || 'Check failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAdminProvider,
    onSuccess: async () => {
      toast.success('Provider deleted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminProvidersQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminDefaultProviderQueryKey }),
        queryClient.invalidateQueries({ queryKey: sharedProvidersQueryKey }),
      ]);
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] delete failed:', mutationError);
      toast.error((mutationError as Error).message || 'Delete failed');
    },
  });
  const toggleEnabledMutation = useMutation({
    mutationFn: patchProviderEnabled,
    onSuccess: async (_data, vars) => {
      toast.success(vars.enabled ? 'Provider enabled' : 'Provider disabled');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminProvidersQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminDefaultProviderQueryKey }),
        queryClient.invalidateQueries({ queryKey: sharedProvidersQueryKey }),
      ]);
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] toggle enabled failed:', mutationError);
      toast.error((mutationError as Error).message || 'Update failed');
    },
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
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] set default failed:', mutationError);
      toast.error((mutationError as Error).message || 'Failed to set default');
    },
  });

  const startCreate = () => {
    setForm(createEmptyForm());
    setCustomModelInput('');
    setEditingId('__new');
  };

  const startEdit = (provider: AdminProviderMasked) => {
    setForm({
      slug: provider.slug,
      displayName: provider.displayName,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl ?? '',
      apiKey: '',
      defaultModel: provider.defaultModel ?? providerDefaultModel(provider.providerType),
      defaultInstructions: provider.defaultInstructions ?? '',
      enabled: provider.enabled,
    });
    setCustomModelInput('');
    setEditingId(provider.id);
  };

  function cancelEdit() {
    setCheckResult(null);
    setEditingId(null);
    setForm(createEmptyForm());
    setCustomModelInput('');
  }

  const runCheck = () => {
    if (checkMutation.isPending) return;
    checkMutation.mutate({ editingId, form });
  };
  const visibleChecks = checkResult?.key === checkKey ? checkResult.items : null;

  const submit = () => {
    if (saveMutation.isPending) return;
    saveMutation.mutate({ editingId, form });
  };

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

  const isEditingExisting = editingId !== null && editingId !== '__new';
  const editingProvider = isEditingExisting
    ? providers.find((p) => p.id === editingId)
    : undefined;
  const submitDisabled =
    saveMutation.isPending ||
    !form.slug.trim() ||
    !form.displayName.trim();

  const selectedProviderType =
    providerTypeOptions.find((opt) => opt.value === form.providerType)
    ?? providerTypeOptions[0];
  const modelDefinitions: TtsModelDefinition[] = useMemo(
    () => resolveProviderModels(form.providerType, {
      apiKey: form.apiKey,
    }),
    [form.providerType, form.apiKey],
  );
  const supportsCustomModel = providerSupportsCustomModel(form.providerType);
  const modelIsPreset = modelDefinitions.some((model) => model.id === form.defaultModel);
  const selectedModelId = modelIsPreset
    ? form.defaultModel
    : supportsCustomModel
      ? 'custom'
      : modelDefinitions[0]?.id ?? '';
  const selectedModelDefinition = modelDefinitions.find((model) => model.id === selectedModelId);
  const modelSupportsInstructions = useCallback((model: string, providerType: TtsProviderType = form.providerType) => resolveTtsProviderModelPolicy({
    providerRef: form.slug,
    providerType,
    model,
  }).supportsInstructions, [form.slug, form.providerType]);
  const baseUrlPlaceholder = form.providerType === 'custom-openai'
    ? 'https://your-tts-host/v1'
    : defaultBaseUrlForProviderType(form.providerType);
  const shouldShowBaseUrl = form.providerType === 'custom-openai';
  const shouldShowInstructions = modelSupportsInstructions(form.defaultModel);

  useEffect(() => {
    if (!supportsCustomModel) {
      if (customModelInput) setCustomModelInput('');
      return;
    }
    if (!modelIsPreset && form.defaultModel && customModelInput !== form.defaultModel) {
      setCustomModelInput(form.defaultModel);
    }
    if (modelIsPreset && customModelInput) {
      setCustomModelInput('');
    }
  }, [supportsCustomModel, modelIsPreset, form.defaultModel, customModelInput]);

  useEffect(() => {
    if (modelSupportsInstructions(form.defaultModel)) return;
    if (!form.defaultInstructions) return;
    setForm((prev) => ({ ...prev, defaultInstructions: '' }));
  }, [form.defaultModel, form.defaultInstructions, form.providerType, form.slug, modelSupportsInstructions]);

  const rowActionsDisabled = deleteMutation.isPending || toggleEnabledMutation.isPending || setDefaultMutation.isPending;

  return (
    <div className="space-y-3">
      {(onDevice || providers.some((p) => p.providerType === 'kokoro-local')) && <LocalVoicesCard />}
      <div className="divide-y divide-line-soft rounded-lg border border-line-soft bg-surface-solid">
        {isLoading ? (
          <ProvidersListSkeleton />
        ) : providers.length === 0 ? (
          <p className="px-3 py-3 text-sm text-soft">No shared providers yet</p>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={`truncate text-sm font-medium ${p.enabled ? 'text-foreground' : 'text-soft'}`}>{p.displayName}</span>
                  {defaultProviderSlug === p.slug && <Badge tone="accent">Default</Badge>}
                  {!p.enabled && <Badge tone="muted">Disabled</Badge>}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-soft" title={p.defaultModel ?? undefined}>
                  {p.slug} · {p.defaultModel ? truncateModelLabel(p.defaultModel) : 'no default model'}
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
                    <MenuActionItem onClick={() => startEdit(p)}>
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
        <button
          type="button"
          onClick={startCreate}
          className="flex w-full items-center gap-2 rounded-b-lg px-3 py-2.5 text-sm font-medium text-accent transition-colors duration-base hover:bg-accent-wash focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
          Add provider
        </button>
      </div>

      <ModalFrame open={editingId !== null} onClose={cancelEdit} size="lg">
        <ModalTitle>{isEditingExisting ? 'Edit provider' : 'New provider'}</ModalTitle>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Slug">
              <Input
                type="text"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="kokoro-prod"
                disabled={isEditingExisting}
              />
            </Field>
            <Field label="Display name">
              <Input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Kokoro (production)"
              />
            </Field>
            <Field label="Provider type">
              <Select
                value={selectedProviderType}
                options={providerTypeOptions}
                getOptionKey={(option) => option.value}
                renderValue={(option) => option.label}
                renderOption={(option, { selected }) => (
                  <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                    {option.label}
                  </span>
                )}
                chevronClassName="h-4 w-4 text-muted"
                onChange={(opt) => {
                  const nextModel = providerDefaultModel(opt.value);
                  setForm({
                    ...form,
                    providerType: opt.value,
                    baseUrl: opt.value === 'custom-openai' ? form.baseUrl : '',
                    defaultModel: nextModel,
                    defaultInstructions: modelSupportsInstructions(nextModel, opt.value) ? form.defaultInstructions : '',
                  });
                  setCustomModelInput('');
                }}
              />
            </Field>
            <Field label="Default model">
              <div className="space-y-2">
                <Select
                  value={selectedModelDefinition}
                  options={modelDefinitions}
                  getOptionKey={(model) => model.id}
                  renderValue={(model) => model.name}
                  renderOption={(model, { selected }) => (
                    <span className={`block ${selected ? 'font-medium' : 'font-normal'}`}>
                      <span className="block truncate">{model.name}</span>
                      {model.id.includes(':') ? (
                        <SelectOptionDetail className="truncate">
                          {model.id.slice(model.id.indexOf(':'))}
                        </SelectOptionDetail>
                      ) : null}
                    </span>
                  )}
                  placeholder="Select model"
                  chevronClassName="h-4 w-4 text-muted"
                  onChange={(model) => {
                    if (model.id === 'custom') {
                      const nextModel = customModelInput.trim();
                      setForm({
                        ...form,
                        defaultModel: nextModel,
                        defaultInstructions: modelSupportsInstructions(nextModel) ? form.defaultInstructions : '',
                      });
                      return;
                    }
                    setForm({
                      ...form,
                      defaultModel: model.id,
                      defaultInstructions: modelSupportsInstructions(model.id) ? form.defaultInstructions : '',
                    });
                    setCustomModelInput('');
                  }}
                />
                {supportsCustomModel && selectedModelId === 'custom' && (
                  <Input
                    type="text"
                    value={customModelInput}
                    onChange={(e) => {
                      const nextModel = e.target.value;
                      setCustomModelInput(nextModel);
                      setForm({
                        ...form,
                        defaultModel: nextModel,
                        defaultInstructions: modelSupportsInstructions(nextModel) ? form.defaultInstructions : '',
                      });
                    }}
                    placeholder="Enter custom model id"
                  />
                )}
              </div>
            </Field>
            {shouldShowInstructions && (
              <Field label="TTS instructions" className="sm:col-span-2">
                <Textarea
                  value={form.defaultInstructions}
                  onChange={(e) => setForm({ ...form, defaultInstructions: e.target.value })}
                  placeholder="Optional"
                  className="min-h-24 resize-y"
                />
              </Field>
            )}
            {shouldShowBaseUrl && (
              <Field label="Base URL" className="sm:col-span-2">
                <Input
                  type="text"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder={baseUrlPlaceholder}
                />
              </Field>
            )}
            {form.providerType === 'kokoro-local' ? (
              <p className="text-sm text-muted sm:col-span-2">
                {onDevice
                  ? 'Runs Kokoro-82M on this device. No key is needed; OpenReader downloads about 336 MB of model, voice and pronunciation data the first time it speaks.'
                  : 'Runs Kokoro-82M on the compute worker itself. No key is needed; the worker downloads about 336 MB of model, voice and pronunciation data the first time it speaks.'}
              </p>
            ) : (
              <Field label="API key" className="sm:col-span-2">
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={editingProvider?.apiKeyMask.startsWith('••••') ? `Keep existing (${editingProvider.apiKeyMask})` : 'Optional'}
                />
              </Field>
            )}
          </div>

          <ToggleRow
            label="Enabled"
            checked={form.enabled}
            onChange={(checked) => setForm({ ...form, enabled: checked })}
            variant="flat"
          />

          {visibleChecks && (
            <ul
              className="divide-y divide-line-soft rounded-lg border border-line-soft bg-surface-solid"
              aria-label="Provider check results"
            >
              {visibleChecks.map((item) => {
                const badge = CHECK_BADGE[item.status];
                return (
                  <li key={item.id} className="px-3 py-2" data-status={item.status}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">{item.label}</span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-soft">{item.detail}</p>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={runCheck}
              disabled={checkMutation.isPending}
              variant="outline"
              size="sm"
            >
              {checkMutation.isPending ? 'Checking…' : 'Check'}
            </Button>
            <span className="flex-1" />
            <Button onClick={cancelEdit} variant="secondary" size="sm">
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitDisabled}
              variant="primary"
              size="sm"
            >
              {saveMutation.isPending ? 'Saving…' : isEditingExisting ? 'Save changes' : 'Create'}
            </Button>
          </div>
        </div>
      </ModalFrame>

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

function ProvidersListSkeleton() {
  return (
    <div className="animate-pulse divide-y divide-line-soft" aria-label="Loading shared providers" aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-36 rounded bg-offbase" />
            <div className="h-3 w-56 rounded bg-offbase" />
          </div>
          <div className="h-7 w-7 shrink-0 rounded-md bg-offbase" />
        </div>
      ))}
    </div>
  );
}
