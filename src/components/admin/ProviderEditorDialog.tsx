'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronLeftIcon, ExternalLinkIcon } from '@/components/icons/Icons';
import {
  Badge,
  type BadgeTone,
  Button,
  Field,
  Input,
  ModalFrame,
  ModalTitle,
  Select,
  SelectOptionDetail,
  Textarea,
  ToggleRow,
} from '@/components/ui';
import { EXTERNAL_PROVIDER_ORDER, PROVIDER_BRANDS, ProviderLogo } from '@/components/providers/provider-brands';
import type { ProviderCheckItem, ProviderCheckStatus } from '@/lib/shared/provider-check';
import {
  providerSupportsCustomModel,
  isBuiltInTtsProviderId,
  resolveProviderModels,
  supportsTtsInstructions,
  type TtsProviderId,
} from '@openreader/tts/provider-catalog';
import { defaultModelForProviderType } from '@openreader/tts/provider-policy';
import { useOpenRouterModels } from '@/hooks/useOpenRouterModels';

export interface AdminProviderMasked {
  id: string;
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  baseUrl: string | null;
  apiKeyMask: string;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ProviderEditorTarget = { kind: 'new' } | { kind: 'edit'; provider: AdminProviderMasked };

interface FormState {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  defaultInstructions: string;
  enabled: boolean;
}

const CHECK_BADGE: Record<ProviderCheckStatus, { tone: BadgeTone; label: string }> = {
  ok: { tone: 'accent', label: 'OK' },
  warn: { tone: 'foreground', label: 'Check' },
  error: { tone: 'danger', label: 'Fix' },
  skipped: { tone: 'muted', label: 'Skipped' },
};

const CUSTOM_MODEL_ID = 'custom';

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** The slug a new provider gets from its name, numbered past any taken one. */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!base || (!taken.has(base) && !isBuiltInTtsProviderId(base))) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate) && !isBuiltInTtsProviderId(candidate)) return candidate;
  }
}

function formFor(providerType: TtsProviderId): FormState {
  return {
    slug: '',
    displayName: providerType === 'custom-openai' ? '' : PROVIDER_BRANDS[providerType].name,
    providerType,
    baseUrl: '',
    apiKey: '',
    defaultModel: defaultModelForProviderType(providerType),
    defaultInstructions: '',
    enabled: true,
  };
}

function formFromProvider(provider: AdminProviderMasked): FormState {
  return {
    slug: provider.slug,
    displayName: provider.displayName,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl ?? '',
    apiKey: '',
    defaultModel: provider.defaultModel ?? defaultModelForProviderType(provider.providerType),
    defaultInstructions: provider.defaultInstructions ?? '',
    enabled: provider.enabled,
  };
}

async function readError(res: Response): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(data.error || `HTTP ${res.status}`);
}

function requestBody(form: FormState) {
  return {
    slug: form.slug.trim(),
    displayName: form.displayName.trim(),
    providerType: form.providerType,
    baseUrl: form.baseUrl.trim() || null,
    ...(form.apiKey.length > 0 ? { apiKey: form.apiKey } : {}),
    defaultModel: form.defaultModel.trim() || null,
    defaultInstructions: supportsTtsInstructions(form.defaultModel, form.providerType) ? form.defaultInstructions.trim() || null : null,
    enabled: form.enabled,
  };
}

async function saveProvider(input: { editingId: string | null; form: FormState }): Promise<void> {
  const res = await fetch(input.editingId ? `/api/admin/providers/${input.editingId}` : '/api/admin/providers', {
    method: input.editingId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(input.form)),
  });
  if (!res.ok) throw await readError(res);
}

async function checkProvider(input: { editingId: string | null; form: FormState }): Promise<ProviderCheckItem[]> {
  const res = await fetch('/api/admin/providers/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(input.editingId ? { providerId: input.editingId } : {}),
      providerType: input.form.providerType,
      baseUrl: input.form.baseUrl.trim(),
      apiKey: input.form.apiKey,
      defaultModel: input.form.defaultModel.trim(),
      defaultInstructions: input.form.defaultInstructions.trim(),
    }),
  });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { checks: ProviderCheckItem[] }).checks;
}

/**
 * Adding an external provider: pick the service from its logo, then fill in
 * only what that service needs. Editing opens straight on the form.
 */
export function ProviderEditorDialog({
  target,
  takenSlugs,
  onClose,
  onSaved,
}: {
  target: ProviderEditorTarget | null;
  takenSlugs: ReadonlySet<string>;
  onClose: () => void;
  onSaved: (created: boolean) => Promise<void> | void;
}) {
  const editing = target?.kind === 'edit' ? target.provider : null;
  const [form, setForm] = useState<FormState | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  // Results belong to the exact form they checked; any edit hides them.
  const [checkResult, setCheckResult] = useState<{ key: string; items: ProviderCheckItem[] } | null>(null);

  useEffect(() => {
    if (!target) return;
    setForm(target.kind === 'edit' ? formFromProvider(target.provider) : null);
    setSlugEdited(false);
    setCheckResult(null);
  }, [target]);

  const editingId = editing?.id ?? null;
  const checkKey = JSON.stringify({ editingId, form });

  const saveMutation = useMutation({
    mutationFn: saveProvider,
    onSuccess: async (_data, variables) => {
      toast.success(variables.editingId ? 'Provider updated' : 'Provider added');
      await onSaved(!variables.editingId);
      onClose();
    },
    onError: (error) => {
      console.error('[ProviderEditorDialog] save failed:', error);
      toast.error((error as Error).message || 'Save failed');
    },
  });
  const checkMutation = useMutation({
    mutationFn: checkProvider,
    onSuccess: (items, variables) => setCheckResult({ key: JSON.stringify(variables), items }),
    onError: (error) => {
      console.error('[ProviderEditorDialog] check failed:', error);
      toast.error((error as Error).message || 'Check failed');
    },
  });

  const update = (patch: Partial<FormState>) => setForm((prev) => {
    if (!prev) return prev;
    const next = { ...prev, ...patch };
    if (!editing && !slugEdited && patch.displayName !== undefined) {
      next.slug = uniqueSlug(next.displayName, takenSlugs);
    }
    return next;
  });

  const pick = (providerType: TtsProviderId) => {
    const next = formFor(providerType);
    setForm({ ...next, slug: uniqueSlug(next.displayName, takenSlugs) });
  };

  const brand = form ? PROVIDER_BRANDS[form.providerType] : null;
  const title = !form || !brand ? 'Add provider' : editing ? `Edit ${editing.displayName}` : `Add ${brand.name}`;
  const visibleChecks = checkResult?.key === checkKey ? checkResult.items : null;

  return (
    <ModalFrame open={target !== null} onClose={onClose} size="lg">
      <div className="flex items-center gap-3">
        {form ? <ProviderLogo providerType={form.providerType} size="lg" /> : null}
        <ModalTitle className="min-w-0 flex-1 truncate">{title}</ModalTitle>
      </div>
      {form ? (
        <ProviderForm
          form={form}
          editing={editing}
          visibleChecks={visibleChecks}
          checking={checkMutation.isPending}
          saving={saveMutation.isPending}
          onChange={update}
          onSlugChange={(slug) => {
            setSlugEdited(true);
            setForm((prev) => (prev ? { ...prev, slug } : prev));
          }}
          onBack={editing ? undefined : () => setForm(null)}
          onCancel={onClose}
          onCheck={() => {
            if (!checkMutation.isPending) checkMutation.mutate({ editingId, form });
          }}
          onSubmit={() => {
            if (!saveMutation.isPending) saveMutation.mutate({ editingId, form });
          }}
        />
      ) : (
        <ProviderPicker onPick={pick} onCancel={onClose} />
      )}
    </ModalFrame>
  );
}

function ProviderPicker({ onPick, onCancel }: { onPick: (providerType: TtsProviderId) => void; onCancel: () => void }) {
  return (
    <div className="mt-4 space-y-4">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Provider services">
        {EXTERNAL_PROVIDER_ORDER.map((providerType) => {
          const brand = PROVIDER_BRANDS[providerType];
          return (
            <li key={providerType}>
              <button
                type="button"
                onClick={() => onPick(providerType)}
                className="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-surface-solid p-3 text-left transition-colors duration-base hover:border-accent-line hover:bg-accent-wash focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ProviderLogo providerType={providerType} size="lg" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{brand.name}</span>
                  <span className="mt-0.5 block text-xs text-soft">{brand.summary}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button onClick={onCancel} variant="secondary" size="sm">Cancel</Button>
      </div>
    </div>
  );
}

function ProviderForm({
  form,
  editing,
  visibleChecks,
  checking,
  saving,
  onChange,
  onSlugChange,
  onBack,
  onCancel,
  onCheck,
  onSubmit,
}: {
  form: FormState;
  editing: AdminProviderMasked | null;
  visibleChecks: ProviderCheckItem[] | null;
  checking: boolean;
  saving: boolean;
  onChange: (patch: Partial<FormState>) => void;
  onSlugChange: (slug: string) => void;
  onBack?: () => void;
  onCancel: () => void;
  onCheck: () => void;
  onSubmit: () => void;
}) {
  const brand = PROVIDER_BRANDS[form.providerType];
  const isCustom = form.providerType === 'custom-openai';
  const catalog = useOpenRouterModels(form.providerType === 'openrouter');
  const models = useMemo(() => resolveProviderModels(form.providerType, { openRouterModels: catalog.data }), [form.providerType, catalog.data]);
  const supportsCustomModel = providerSupportsCustomModel(form.providerType);
  const modelIsPreset = models.some((model) => model.id === form.defaultModel);
  const selectedModelId = modelIsPreset ? form.defaultModel : supportsCustomModel ? CUSTOM_MODEL_ID : models[0]?.id ?? '';
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const [customModel, setCustomModel] = useState(modelIsPreset ? '' : form.defaultModel);
  const keptKey = editing?.apiKeyMask.startsWith('••••') ? editing.apiKeyMask : null;
  const submitDisabled = saving || !form.slug.trim() || !form.displayName.trim() || (isCustom && !form.baseUrl.trim());

  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitDisabled) onSubmit();
      }}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {isCustom && (
          <Field label="Base URL" className="sm:col-span-2">
            <Input
              type="url"
              aria-label="Base URL"
              value={form.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder="https://your-tts-host/v1"
            />
          </Field>
        )}
        <Field label="Display name">
          <Input
            type="text"
            aria-label="Display name"
            value={form.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            placeholder={isCustom ? 'Kokoro-FastAPI' : brand.name}
          />
        </Field>
        <Field label="Default model">
          <div className="space-y-2">
            <Select
              aria-label="Default model"
              value={selectedModel}
              options={models}
              getOptionKey={(model) => model.id}
              renderValue={(model) => model.name}
              renderOption={(model, { selected }) => (
                <span className={`block ${selected ? 'font-medium' : 'font-normal'}`}>
                  <span className="block truncate">{model.name}</span>
                  {model.id.includes(':') ? (
                    <SelectOptionDetail className="truncate">{model.id.slice(model.id.indexOf(':'))}</SelectOptionDetail>
                  ) : null}
                </span>
              )}
              chevronClassName="h-4 w-4 text-muted"
              onChange={(model) => onChange({ defaultModel: model.id === CUSTOM_MODEL_ID ? customModel.trim() : model.id })}
            />
            {supportsCustomModel && selectedModelId === CUSTOM_MODEL_ID && (
              <Input
                type="text"
                aria-label="Model ID"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  onChange({ defaultModel: e.target.value });
                }}
                placeholder={form.providerType === 'replicate' ? 'owner/model or owner/model:version' : 'Model ID'}
              />
            )}
          </div>
        </Field>
        <Field
          label="API key"
          className="sm:col-span-2"
          action={brand.apiKeyUrl ? (
            <a
              href={brand.apiKeyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              Get a key
              <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : undefined}
        >
          <Input
            type="password"
            aria-label="API key"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={keptKey ? `Keep existing (${keptKey})` : isCustom ? 'Optional' : ''}
          />
        </Field>
        {supportsTtsInstructions(form.defaultModel, form.providerType) && (
          <Field label="TTS instructions" className="sm:col-span-2">
            <Textarea
              aria-label="TTS instructions"
              value={form.defaultInstructions}
              onChange={(e) => onChange({ defaultInstructions: e.target.value })}
              placeholder="Optional"
              className="min-h-24 resize-y"
            />
          </Field>
        )}
      </div>

      <details className="group rounded-lg border border-line-soft bg-surface-solid">
        <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Advanced
        </summary>
        <div className="space-y-2.5 border-t border-line-soft px-3 py-3">
          <Field label="Slug" hint={editing ? undefined : 'Saved in user settings. It cannot change later.'}>
            <Input
              type="text"
              aria-label="Slug"
              value={form.slug}
              onChange={(e) => onSlugChange(e.target.value)}
              disabled={Boolean(editing)}
              className="font-mono"
            />
          </Field>
          <ToggleRow
            label="Enabled"
            checked={form.enabled}
            onChange={(checked) => onChange({ enabled: checked })}
            variant="flat"
          />
        </div>
      </details>

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
        {onBack && (
          <Button type="button" onClick={onBack} variant="ghost" size="sm" className="gap-1">
            <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Back
          </Button>
        )}
        <Button type="button" onClick={onCheck} disabled={checking} variant="outline" size="sm">
          {checking ? 'Checking…' : 'Check'}
        </Button>
        <span className="flex-1" />
        <Button type="button" onClick={onCancel} variant="secondary" size="sm">Cancel</Button>
        <Button type="submit" disabled={submitDisabled} variant="primary" size="sm">
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add provider'}
        </Button>
      </div>
    </form>
  );
}
