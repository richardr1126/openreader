'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { DotsHorizontalIcon, PlusIcon } from '@/components/icons/Icons';
import { providerSupportsCustomModel, resolveProviderModels, type TtsModelDefinition, type TtsProviderId, type TtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { defaultBaseUrlForProviderType, defaultModelForProviderType, resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import {
  Badge,
  Field,
  Section,
  ToggleRow,
  Select,
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
];

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
const ADMIN_PROVIDERS_QUERY_KEY = ['admin-providers'] as const;
const ADMIN_SETTINGS_QUERY_KEY = ['admin-settings'] as const;
const ADMIN_DEFAULT_PROVIDER_QUERY_KEY = ['admin-settings', 'default-provider-slug'] as const;

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

async function deleteAdminProvider(id: string): Promise<void> {
  const res = await fetch(`/api/admin/providers/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

export function AdminProvidersPanel() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => createEmptyForm());
  const [customModelInput, setCustomModelInput] = useState('');

  const { data: providers = [], isPending: isLoading, error } = useQuery({
    queryKey: ADMIN_PROVIDERS_QUERY_KEY,
    queryFn: fetchAdminProviders,
  });
  const {
    data: defaultProviderSlug = '',
    error: defaultProviderError,
  } = useQuery({
    queryKey: ADMIN_DEFAULT_PROVIDER_QUERY_KEY,
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
        queryClient.invalidateQueries({ queryKey: ADMIN_PROVIDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_DEFAULT_PROVIDER_QUERY_KEY }),
      ]);
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] save failed:', mutationError);
      toast.error((mutationError as Error).message || 'Save failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAdminProvider,
    onSuccess: async () => {
      toast.success('Provider deleted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ADMIN_PROVIDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_DEFAULT_PROVIDER_QUERY_KEY }),
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
        queryClient.invalidateQueries({ queryKey: ADMIN_PROVIDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_DEFAULT_PROVIDER_QUERY_KEY }),
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
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_DEFAULT_PROVIDER_QUERY_KEY }),
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
    setEditingId(null);
    setForm(createEmptyForm());
    setCustomModelInput('');
  }

  const submit = () => {
    if (saveMutation.isPending) return;
    saveMutation.mutate({ editingId, form });
  };

  const remove = (id: string) => {
    if (!confirm('Delete this shared provider? Users selecting it will lose access until they switch.')) return;
    if (deleteMutation.isPending) return;
    deleteMutation.mutate(id);
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
    PROVIDER_TYPE_OPTIONS.find((opt) => opt.value === form.providerType)
    ?? PROVIDER_TYPE_OPTIONS[0];
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

  return (
    <Section
      title="Shared TTS providers"
      subtitle="Server-side providers visible to all users. API keys are encrypted at rest and never sent to the client."
      action={
        <div className="flex items-center gap-2">
          <Badge tone="foreground">Shared</Badge>
          {!editingId ? (
            <Button
              onClick={startCreate}
              variant="primary"
              size="icon"
              aria-label="Add provider"
              title="Add provider"
            >
              <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
    >
      {editingId && (
        <div className="space-y-2.5 pb-3 border-b border-offbase">
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-semibold text-foreground">
              {isEditingExisting ? `Edit "${editingProvider?.slug}"` : 'New provider'}
            </h4>
            {isEditingExisting && (
              <span className="text-xs text-muted">slug cannot be changed after create</span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
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
                options={PROVIDER_TYPE_OPTIONS}
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
            <Field label="Default model" hint="Pre-selected for users picking this provider.">
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
                        <span className="block truncate text-xs text-muted">
                          {model.id.slice(model.id.indexOf(':'))}
                        </span>
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
              <Field
                label="TTS instructions"
                className="sm:col-span-2"
                hint="Optional. Applied by default when this shared provider is selected."
              >
                <Textarea
                  value={form.defaultInstructions}
                  onChange={(e) => setForm({ ...form, defaultInstructions: e.target.value })}
                  placeholder="Enter instructions for this model"
                  className="min-h-24 resize-y"
                />
              </Field>
            )}
            {shouldShowBaseUrl && (
              <Field label="Base URL" className="sm:col-span-2" hint="Optional. Falls back to the provider type's default when blank.">
                <Input
                  type="text"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder={baseUrlPlaceholder}
                />
              </Field>
            )}
            <Field
              label={isEditingExisting ? 'API key (leave blank to keep existing)' : 'API key (optional)'}
              className="sm:col-span-2"
              hint="Stored encrypted with AES-256-GCM. Never returned to clients."
            >
              <Input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={isEditingExisting ? `keep existing (${editingProvider?.apiKeyMask ?? ''})` : 'Optional'}
              />
            </Field>
          </div>

          <ToggleRow
            label="Enabled"
            description="When off, this provider is hidden from users without being deleted."
            checked={form.enabled}
            onChange={(checked) => setForm({ ...form, enabled: checked })}
            variant="flat"
          />

          <div className="pt-1 flex justify-end gap-2">
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
      )}

      <div className="space-y-0">
        {isLoading ? (
          <ProvidersListSkeleton />
        ) : providers.length === 0 ? (
          <p className="text-xs text-muted py-2">No shared providers configured yet.</p>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="py-1.5 border-b border-offbase last:border-b-0 px-0.5 rounded-md">
              <div className="flex items-start gap-2.5">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">{p.displayName}</span>
                    <Badge tone="muted">{p.slug}</Badge>
                    {defaultProviderSlug === p.slug && <Badge tone="foreground">Default</Badge>}
                    {!p.enabled && <Badge tone="muted">Disabled</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {p.providerType}
                    {p.defaultModel ? (
                      <>
                        {' · '}
                        <span title={p.defaultModel}>{truncateModelLabel(p.defaultModel)}</span>
                      </>
                    ) : (
                      ' · no default model'
                    )}
                    {p.defaultInstructions ? ' · instructions' : ''}
                  </div>
                  <div className="text-[11px] text-muted truncate">
                    {p.baseUrl ? p.baseUrl : 'provider base URL default'} · key {p.apiKeyMask}
                  </div>
                </div>
                <MenuRoot as="div" className="relative shrink-0">
                  <MenuTrigger
                    as={IconButton}
                    tone="surface"
                    size="sm"
                    title="Provider actions"
                    aria-label="Provider actions"
                    disabled={!!editingId || deleteMutation.isPending || toggleEnabledMutation.isPending || setDefaultMutation.isPending}
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
                      <MenuActionItem tone="danger" onClick={() => remove(p.id)}>
                        Delete
                      </MenuActionItem>
                    </MenuItemsSurface>
                  </MenuTransition>
                </MenuRoot>
              </div>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

function ProvidersListSkeleton() {
  const rows = Array.from({ length: 4 });
  return (
    <div className="animate-pulse space-y-0.5" aria-label="Loading shared providers" aria-busy="true">
      {rows.map((_, index) => (
        <div key={index} className="py-1.5 border-b border-offbase last:border-b-0">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="h-4 w-36 rounded bg-offbase" />
                <div className="h-4 w-20 rounded bg-offbase" />
              </div>
              <div className="h-3 w-4/5 rounded bg-offbase" />
            </div>
            <div className="shrink-0 flex gap-1.5 pt-0.5">
              <div className="h-7 w-14 rounded-md bg-offbase" />
              <div className="h-7 w-16 rounded-md bg-offbase" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
