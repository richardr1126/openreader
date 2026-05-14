'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Listbox, ListboxButton, ListboxOption, ListboxOptions, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronUpDownIcon, CheckIcon, PlusIcon } from '@/components/icons/Icons';
import { providerSupportsCustomModel, resolveProviderModels, type TtsModelDefinition, type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { defaultBaseUrlForProviderType, defaultModelForProviderType, resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import {
  Badge,
  Field,
  Section,
  ToggleRow,
  btnDanger,
  btnOutline,
  btnPrimary,
  btnSecondary,
  inputClass,
  listboxButtonClass,
  listboxOptionClass,
  listboxOptionsClass,
} from '@/components/formPrimitives';

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
  const runtimeConfig = useRuntimeConfig();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => createEmptyForm());
  const [customModelInput, setCustomModelInput] = useState('');

  const { data: providers = [], isPending: isLoading, error } = useQuery({
    queryKey: ADMIN_PROVIDERS_QUERY_KEY,
    queryFn: fetchAdminProviders,
  });

  useEffect(() => {
    if (!error) return;
    console.error('[AdminProvidersPanel] load failed:', error);
    toast.error('Failed to load admin providers');
  }, [error]);

  const saveMutation = useMutation({
    mutationFn: upsertAdminProvider,
    onSuccess: async (_data, variables) => {
      toast.success(variables.editingId === '__new' ? 'Provider created' : 'Provider updated');
      cancelEdit();
      await queryClient.invalidateQueries({ queryKey: ADMIN_PROVIDERS_QUERY_KEY });
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
      await queryClient.invalidateQueries({ queryKey: ADMIN_PROVIDERS_QUERY_KEY });
    },
    onError: (mutationError) => {
      console.error('[AdminProvidersPanel] delete failed:', mutationError);
      toast.error((mutationError as Error).message || 'Delete failed');
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
      showAllDeepInfra: runtimeConfig.showAllDeepInfraModels,
    }),
    [form.providerType, form.apiKey, runtimeConfig.showAllDeepInfraModels],
  );
  const supportsCustomModel = providerSupportsCustomModel(form.providerType);
  const modelIsPreset = modelDefinitions.some((model) => model.id === form.defaultModel);
  const selectedModelId = modelIsPreset
    ? form.defaultModel
    : supportsCustomModel
      ? 'custom'
      : modelDefinitions[0]?.id ?? '';
  const selectedModelDefinition = modelDefinitions.find((model) => model.id === selectedModelId);
  const modelSupportsInstructions = useCallback((model: string) => resolveTtsProviderModelPolicy({
    providerRef: form.slug,
    providerType: form.providerType,
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
              className={`${btnPrimary} h-7 w-7 p-0 inline-flex items-center justify-center`}
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
                className={inputClass}
                disabled={isEditingExisting}
              />
            </Field>
            <Field label="Display name">
              <Input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Kokoro (production)"
                className={inputClass}
              />
            </Field>
            <Field label="Provider type">
              <Listbox
                value={selectedProviderType}
                onChange={(opt) => {
                  const nextModel = providerDefaultModel(opt.value);
                  setForm({
                    ...form,
                    providerType: opt.value,
                    baseUrl: opt.value === 'custom-openai' ? form.baseUrl : '',
                    defaultModel: nextModel,
                    defaultInstructions: modelSupportsInstructions(nextModel) ? form.defaultInstructions : '',
                  });
                  setCustomModelInput('');
                }}
              >
                <ListboxButton className={listboxButtonClass}>
                  <span className="block truncate">{selectedProviderType.label}</span>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                    <ChevronUpDownIcon className="h-4 w-4 text-muted" />
                  </span>
                </ListboxButton>
                <Transition
                  as={Fragment}
                  leave="transition ease-in duration-100"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <ListboxOptions anchor="bottom start" className={listboxOptionsClass}>
                    {PROVIDER_TYPE_OPTIONS.map((opt) => (
                      <ListboxOption
                        key={opt.value}
                        value={opt}
                        className={({ active }) => listboxOptionClass(active)}
                      >
                        {({ selected }) => (
                          <>
                            <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                              {opt.label}
                            </span>
                            {selected && (
                              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                <CheckIcon className="h-5 w-5" />
                              </span>
                            )}
                          </>
                        )}
                      </ListboxOption>
                    ))}
                  </ListboxOptions>
                </Transition>
              </Listbox>
            </Field>
            <Field label="Default model" hint="Pre-selected for users picking this provider.">
              <div className="space-y-2">
                <Listbox
                  value={selectedModelId}
                  onChange={(modelId: string) => {
                    if (modelId === 'custom') {
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
                      defaultModel: modelId,
                      defaultInstructions: modelSupportsInstructions(modelId) ? form.defaultInstructions : '',
                    });
                    setCustomModelInput('');
                  }}
                >
                <ListboxButton className={listboxButtonClass}>
                  <span className="block truncate">
                    {selectedModelDefinition?.name ?? 'Select model'}
                  </span>
                    <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                      <ChevronUpDownIcon className="h-4 w-4 text-muted" />
                    </span>
                  </ListboxButton>
                  <Transition
                    as={Fragment}
                    leave="transition ease-in duration-100"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                  >
                    <ListboxOptions anchor="bottom start" className={listboxOptionsClass}>
                      {modelDefinitions.map((model) => (
                        <ListboxOption
                          key={model.id}
                          value={model.id}
                          className={({ active }) => listboxOptionClass(active)}
                        >
                          {({ selected }) => (
                            <>
                              <span className={`block ${selected ? 'font-medium' : 'font-normal'}`}>
                                <span className="block truncate">{model.name}</span>
                                {model.id.includes(':') && (
                                  <span className="block truncate text-xs text-muted">
                                    {model.id.slice(model.id.indexOf(':'))}
                                  </span>
                                )}
                              </span>
                              {selected && (
                                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                  <CheckIcon className="h-5 w-5" />
                                </span>
                              )}
                            </>
                          )}
                        </ListboxOption>
                      ))}
                    </ListboxOptions>
                  </Transition>
                </Listbox>
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
                    className={inputClass}
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
                <textarea
                  value={form.defaultInstructions}
                  onChange={(e) => setForm({ ...form, defaultInstructions: e.target.value })}
                  placeholder="Enter instructions for this model"
                  className={`${inputClass} min-h-24 resize-y`}
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
                  className={inputClass}
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
                className={inputClass}
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
            <Button onClick={cancelEdit} className={`${btnSecondary} px-4 py-1.5`}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitDisabled}
              className={`${btnPrimary} px-4 py-1.5`}
            >
              {saveMutation.isPending ? 'Saving…' : isEditingExisting ? 'Save changes' : 'Create'}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-0">
        {isLoading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-muted py-2">No shared providers configured yet.</p>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="py-1.5 border-b border-offbase last:border-b-0">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">{p.displayName}</span>
                    <Badge tone="muted">{p.slug}</Badge>
                    {!p.enabled && <Badge tone="muted">Disabled</Badge>}
                  </div>
                  <div className="text-xs text-muted truncate">
                    {p.providerType}
                    {p.defaultModel ? ` · ${p.defaultModel}` : ''}
                    {p.defaultInstructions ? ' · instructions' : ''}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                    {' · '}key {p.apiKeyMask}
                  </div>
                </div>
                <div className="shrink-0 flex gap-1.5">
                  <Button
                    onClick={() => startEdit(p)}
                    className={`${btnOutline} px-2.5 py-1 text-xs`}
                    disabled={!!editingId || deleteMutation.isPending}
                  >
                    Edit
                  </Button>
                  <Button
                    onClick={() => remove(p.id)}
                    className={`${btnDanger} px-2.5 py-1 text-xs`}
                    disabled={!!editingId || deleteMutation.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}
