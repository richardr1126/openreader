'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button, Listbox, ListboxButton, ListboxOption, ListboxOptions, Transition } from '@headlessui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronUpDownIcon, CheckIcon } from '@/components/icons/Icons';
import {
  Badge,
  Section,
  ToggleRow,
  buttonClass,
  inputClass,
  listboxButtonClass,
  listboxOptionClass,
  listboxOptionsClass,
} from '@/components/formPrimitives';
import { type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { useSharedProviders, type SharedProviderEntry } from '@/hooks/useSharedProviders';

type RuntimeConfigSource = 'json-seed' | 'env-seed' | 'admin' | 'default';

interface SettingsResponse {
  values: Record<string, unknown>;
  sources: Record<string, RuntimeConfigSource>;
}

interface ProviderOption {
  id: string;
  name: string;
  providerType: TtsProviderId;
}

const ADMIN_SETTINGS_QUERY_KEY = ['admin-settings'] as const;

async function fetchAdminSettings(): Promise<SettingsResponse> {
  const res = await fetch('/api/admin/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SettingsResponse;
}

async function patchAdminSettings(payload: { updates?: Record<string, unknown>; reset?: string[] }): Promise<void> {
  const res = await fetch('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
}

export function AdminFeaturesPanel() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
    queryFn: fetchAdminSettings,
  });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const { providers: sharedProviders } = useSharedProviders();

  useEffect(() => {
    if (!data) return;
    setDraft({ ...data.values });
    setDirty(new Set());
  }, [data]);

  useEffect(() => {
    if (!error) return;
    console.error('[AdminFeaturesPanel] load failed:', error);
    toast.error('Failed to load site settings');
  }, [error]);

  const resetMutation = useMutation({
    mutationFn: async (key: string) => {
      await patchAdminSettings({ reset: [key] });
    },
    onSuccess: async () => {
      toast.success('Reset to env default');
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
    },
    onError: (mutationError) => {
      console.error(mutationError);
      toast.error('Reset failed');
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      await patchAdminSettings({ updates });
    },
    onSuccess: async () => {
      toast.success('Settings saved');
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
    },
    onError: (mutationError) => {
      console.error(mutationError);
      toast.error('Save failed');
    },
  });

  const saving = resetMutation.isPending || saveMutation.isPending;

  const updateDraft = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty((s) => {
      const next = new Set(s);
      const baselineValue = data?.values?.[key];
      if (Object.is(value, baselineValue)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updatePositiveIntDraft = (key: string, raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    updateDraft(key, Math.max(1, Math.floor(parsed)));
  };

  const resetField = (key: string) => {
    if (saving) return;
    resetMutation.mutate(key);
  };

  const saveAll = () => {
    if (saving || dirty.size === 0) return;
    const updates: Record<string, unknown> = {};
    for (const key of dirty) updates[key] = draft[key];
    saveMutation.mutate(updates);
  };

  const discardAll = () => {
    if (!data) return;
    setDraft({ ...data.values });
    setDirty(new Set());
  };

  const providerOptions = useMemo<ProviderOption[]>(() => {
    return sharedProviders.map((entry) => ({
      id: entry.slug,
      name: `${entry.displayName} (shared)`,
      providerType: entry.providerType,
    }));
  }, [sharedProviders]);

  const currentProviderId =
    typeof draft.defaultTtsProvider === 'string'
      ? draft.defaultTtsProvider
      : '';
  const currentSharedEntry: SharedProviderEntry | undefined = sharedProviders.find(
    (p) => p.slug === currentProviderId,
  );
  const fallbackShared = providerOptions[0];
  const effectiveSelectedProvider = currentSharedEntry
    ? {
      id: currentSharedEntry.slug,
      name: `${currentSharedEntry.displayName} (shared)`,
      providerType: currentSharedEntry.providerType,
    } as ProviderOption
    : fallbackShared;
  const selectedProviderOption = effectiveSelectedProvider;
  const shouldRenderRateLimitInputs = draft.disableTtsRateLimit === false;
  const shouldRenderComputeRateLimitInputs = draft.disableComputeRateLimit === false;

  const handleProviderChange = (opt: ProviderOption) => {
    updateDraft('defaultTtsProvider', opt.id);
  };

  const renderSource = (key: string) => {
    const source = data?.sources?.[key] ?? 'default';
    const isDirty = dirty.has(key);
    return (
      <SourceBadge
        source={source}
        dirty={isDirty}
        canReset={source !== 'default'}
        onReset={() => resetField(key)}
        saving={saving}
      />
    );
  };

  if (!data) {
    return (
      <AdminFeaturesSkeleton />
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="TTS defaults"
        subtitle="Defaults for new users."
        action={<Badge tone="foreground">Defaults</Badge>}
      >
        <div className="space-y-1.5 pb-2 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Default TTS provider</p>
              <p className="text-xs text-muted mt-0.5">
                Starting provider for new users.
              </p>
            </div>
            <div className="shrink-0">{renderSource('defaultTtsProvider')}</div>
          </div>
          {providerOptions.length > 0 ? (
            <Listbox value={selectedProviderOption} onChange={handleProviderChange}>
              <ListboxButton className={listboxButtonClass}>
                <span className="block truncate">{selectedProviderOption?.name ?? 'Select provider'}</span>
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
                  {providerOptions.map((opt) => (
                    <ListboxOption
                      key={opt.id}
                      value={opt}
                      className={({ active }) => listboxOptionClass(active)}
                    >
                      {({ selected }) => (
                        <>
                          <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                            {opt.name}
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
          ) : (
            <div className="px-0.5 py-2 text-sm text-muted">
              No shared providers yet. Add one first.
            </div>
          )}
        </div>

        <ToggleRow
          label="Restrict user API keys (recommended)"
          description="Only allow admin shared providers."
          checked={Boolean(draft.restrictUserApiKeys)}
          onChange={(checked) => {
            if (!checked) {
              const ok = confirm(
                'Turning this off allows user-supplied API keys to flow through this server. Continue?',
              );
              if (!ok) return;
            }
            updateDraft('restrictUserApiKeys', checked);
          }}
          right={renderSource('restrictUserApiKeys')}
          variant="flat"
        />
        <ToggleRow
          label="Show TTS provider settings tab"
          description="Allow per-user provider overrides."
          checked={Boolean(draft.enableTtsProvidersTab)}
          onChange={(checked) => updateDraft('enableTtsProvidersTab', checked)}
          right={renderSource('enableTtsProvidersTab')}
          variant="flat"
        />
        <ToggleRow
          label="Show all provider models"
          description="Allow model selection beyond defaults."
          checked={Boolean(draft.showAllProviderModels)}
          onChange={(checked) => updateDraft('showAllProviderModels', checked)}
          right={renderSource('showAllProviderModels')}
          variant="flat"
        />
      </Section>

      <Section
        title="Rate limiting"
        subtitle="Daily TTS quotas, PDF parsing throttle, and upload size."
        action={<Badge tone="foreground">Limits</Badge>}
      >
        <ToggleRow
          label="Disable TTS daily rate limiting"
          description="When on, per-user/IP daily character quotas are not enforced."
          checked={Boolean(draft.disableTtsRateLimit)}
          onChange={(checked) => updateDraft('disableTtsRateLimit', checked)}
          right={renderSource('disableTtsRateLimit')}
          variant="flat"
        />
        {shouldRenderRateLimitInputs ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 px-0.5 py-1.5">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Anonymous per-user daily limit</label>
                {renderSource('ttsDailyLimitAnonymous')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.ttsDailyLimitAnonymous ?? '')}
                onChange={(event) => updatePositiveIntDraft('ttsDailyLimitAnonymous', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Authenticated per-user daily limit</label>
                {renderSource('ttsDailyLimitAuthenticated')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.ttsDailyLimitAuthenticated ?? '')}
                onChange={(event) => updatePositiveIntDraft('ttsDailyLimitAuthenticated', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Anonymous IP daily backstop</label>
                {renderSource('ttsIpDailyLimitAnonymous')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.ttsIpDailyLimitAnonymous ?? '')}
                onChange={(event) => updatePositiveIntDraft('ttsIpDailyLimitAnonymous', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Authenticated IP daily backstop</label>
                {renderSource('ttsIpDailyLimitAuthenticated')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.ttsIpDailyLimitAuthenticated ?? '')}
                onChange={(event) => updatePositiveIntDraft('ttsIpDailyLimitAuthenticated', event.target.value)}
              />
            </div>
          </div>
        ) : null}

        <ToggleRow
          label="Disable PDF parsing rate limiting"
          description="When on, per-user limits on starting PDF layout parses are not enforced."
          checked={Boolean(draft.disableComputeRateLimit)}
          onChange={(checked) => updateDraft('disableComputeRateLimit', checked)}
          right={renderSource('disableComputeRateLimit')}
          variant="flat"
        />
        {shouldRenderComputeRateLimitInputs ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 px-0.5 py-1.5">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Burst limit (parses)</label>
                {renderSource('computeParseBurstMax')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.computeParseBurstMax ?? '')}
                onChange={(event) => updatePositiveIntDraft('computeParseBurstMax', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Burst window (seconds)</label>
                {renderSource('computeParseBurstWindowSec')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.computeParseBurstWindowSec ?? '')}
                onChange={(event) => updatePositiveIntDraft('computeParseBurstWindowSec', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Sustained limit (parses)</label>
                {renderSource('computeParseSustainedMax')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.computeParseSustainedMax ?? '')}
                onChange={(event) => updatePositiveIntDraft('computeParseSustainedMax', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-foreground">Sustained window (seconds)</label>
                {renderSource('computeParseSustainedWindowSec')}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.computeParseSustainedWindowSec ?? '')}
                onChange={(event) => updatePositiveIntDraft('computeParseSustainedWindowSec', event.target.value)}
              />
            </div>
          </div>
        ) : null}

        <div className="px-0.5 pt-1 pb-2 border-b border-offbase last:border-b-0">
          <div className="flex items-center gap-2.5">
            <div className="flex-1 min-w-0 space-y-0.5">
              <span className="block text-sm font-medium leading-5 text-foreground">Max upload size</span>
              <span className="block text-xs leading-4 text-muted">Largest single document upload accepted.</span>
            </div>
            <div className="shrink-0 self-start pl-1.5">{renderSource('maxUploadMb')}</div>
            <div className="shrink-0 flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                aria-label="Max upload size in megabytes"
                className="w-20 rounded-md bg-background border border-offbase px-2.5 py-1.5 text-sm text-foreground text-right focus:outline-none focus:ring-2 focus:ring-accent"
                value={String(draft.maxUploadMb ?? '')}
                onChange={(event) => updatePositiveIntDraft('maxUploadMb', event.target.value)}
              />
              <span className="text-xs text-muted">MB</span>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Site features"
        subtitle="Feature flags for all users."
        action={<Badge tone="foreground">Feature Flags</Badge>}
      >
        <div className="space-y-1.5 pb-2 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Changelog feed URL</p>
              <p className="text-xs text-muted mt-0.5">
                Public URL to the changelog manifest JSON used by Settings.
              </p>
            </div>
            <div className="shrink-0">{renderSource('changelogFeedUrl')}</div>
          </div>
          <input
            type="text"
            className={inputClass}
            value={String(draft.changelogFeedUrl ?? '')}
            onChange={(event) => updateDraft('changelogFeedUrl', event.target.value)}
            placeholder="https://docs.openreader.richardr.dev/changelog/manifest.json"
          />
        </div>
        <ToggleRow
          label="Allow new account sign-ups"
          description="When off, new accounts cannot be created. Existing accounts can still sign in."
          checked={Boolean(draft.enableUserSignups)}
          onChange={(checked) => updateDraft('enableUserSignups', checked)}
          right={renderSource('enableUserSignups')}
          variant="flat"
        />
        <ToggleRow
          label="Audiobook export"
          description='Show "Export audiobook" on PDF/EPUB pages.'
          checked={Boolean(draft.enableAudiobookExport)}
          onChange={(checked) => updateDraft('enableAudiobookExport', checked)}
          right={renderSource('enableAudiobookExport')}
          variant="flat"
        />
        <ToggleRow
          label="DOCX upload conversion"
          description="Allow DOCX uploads (converted to PDF)."
          checked={Boolean(draft.enableDocxConversion)}
          onChange={(checked) => updateDraft('enableDocxConversion', checked)}
          right={renderSource('enableDocxConversion')}
          variant="flat"
        />
        <ToggleRow
          label="Destructive delete buttons"
          description='Show "Delete all data" actions (auth-off mode).'
          checked={Boolean(draft.enableDestructiveDeleteActions)}
          onChange={(checked) => updateDraft('enableDestructiveDeleteActions', checked)}
          right={renderSource('enableDestructiveDeleteActions')}
          variant="flat"
        />
      </Section>

      <Section
        title="TTS upstream"
        subtitle="Server-side retry, timeout, and cache controls for TTS generation."
        action={<Badge tone="foreground">Upstream</Badge>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 px-0.5 py-1.5">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Retry attempts</label>
              {renderSource('ttsUpstreamMaxRetries')}
            </div>
            <input
              type="number"
              min={1}
              step={1}
              className={inputClass}
              value={String(draft.ttsUpstreamMaxRetries ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsUpstreamMaxRetries', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Upstream timeout (ms)</label>
              {renderSource('ttsUpstreamTimeoutMs')}
            </div>
            <input
              type="number"
              min={1}
              step={1}
              className={inputClass}
              value={String(draft.ttsUpstreamTimeoutMs ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsUpstreamTimeoutMs', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Audio cache size (bytes)</label>
              {renderSource('ttsCacheMaxSizeBytes')}
            </div>
            <input
              type="number"
              min={1}
              step={1}
              className={inputClass}
              value={String(draft.ttsCacheMaxSizeBytes ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsCacheMaxSizeBytes', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Audio cache TTL (ms)</label>
              {renderSource('ttsCacheTtlMs')}
            </div>
            <input
              type="number"
              min={1}
              step={1}
              className={inputClass}
              value={String(draft.ttsCacheTtlMs ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsCacheTtlMs', event.target.value)}
            />
          </div>
        </div>
      </Section>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {dirty.size > 0
            ? `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}`
            : 'No unsaved changes'}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={discardAll}
            disabled={dirty.size === 0 || saving}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            Discard
          </Button>
          <Button
            onClick={saveAll}
            disabled={dirty.size === 0 || saving}
            className={buttonClass({ variant: 'primary', size: 'sm' })}
          >
            {saving ? 'Saving…' : dirty.size > 0 ? `Save (${dirty.size})` : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AdminFeaturesSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-label="Loading feature settings" aria-busy="true">
      <Section
        title="TTS defaults"
        subtitle="Defaults for new users."
        action={<div className="h-4 w-16 rounded bg-offbase" />}
      >
        <div className="space-y-1.5 pb-2 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="h-4 w-40 rounded bg-offbase" />
              <div className="h-3 w-56 rounded bg-offbase" />
            </div>
            <div className="h-5 w-20 rounded bg-offbase" />
          </div>
          <div className="h-9 w-full rounded-md bg-offbase" />
        </div>
        <div className="space-y-2">
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
        </div>
      </Section>

      <Section
        title="Site features"
        subtitle="Feature flags for all users."
        action={<div className="h-4 w-24 rounded bg-offbase" />}
      >
        <div className="space-y-2">
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
          <div className="h-14 w-full rounded-md border border-offbase bg-background" />
        </div>
      </Section>
    </div>
  );
}

function SourceBadge({
  source,
  dirty,
  canReset,
  onReset,
  saving,
}: {
  source: RuntimeConfigSource;
  dirty: boolean;
  canReset: boolean;
  onReset: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {canReset && !dirty && (
        <button
          type="button"
          onClick={onReset}
          disabled={saving}
          className="text-[11px] font-medium text-muted hover:text-accent transition-colors disabled:opacity-50"
        >
          Reset
        </button>
      )}
      {dirty ? (
        <Badge tone="accent">Modified</Badge>
      ) : source === 'json-seed' ? (
        <Badge tone="muted">from seed</Badge>
      ) : source === 'env-seed' ? (
        <Badge tone="muted">from env</Badge>
      ) : source === 'admin' ? (
        <Badge tone="foreground">admin</Badge>
      ) : (
        <Badge tone="muted">default</Badge>
      )}
    </div>
  );
}
