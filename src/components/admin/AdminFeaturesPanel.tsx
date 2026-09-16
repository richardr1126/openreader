'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Badge,
  Section,
  ToggleRow,
  Select,
  SegmentedControl,
  Button,
  Input,
} from '@/components/ui';
import { type TtsProviderId } from '@openreader/tts/provider-catalog';
import { useSharedProviders, type SharedProviderEntry } from '@/hooks/useSharedProviders';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  parseComputeLimitPolicyDocument,
} from '@openreader/runtime-config/compute-limits';
import { ComputeLimitsEditor } from './ComputeLimitsEditor';

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

type PlaybackBackgroundExtent = 'section' | 'document';
type SignupPolicy = 'open' | 'approval' | 'closed';

interface PlaybackBackgroundExtentOption {
  value: PlaybackBackgroundExtent;
  label: string;
  description: string;
}

const PLAYBACK_BACKGROUND_EXTENT_OPTIONS: PlaybackBackgroundExtentOption[] = [
  {
    value: 'section',
    label: 'Current section',
    description: 'Continue through the current PDF page or EPUB chapter after the client stops heartbeating.',
  },
  {
    value: 'document',
    label: 'Full document',
    description: 'Continue generating from the current position through the rest of the document.',
  },
];

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

export function AdminFeaturesPanel({
  scope = 'all',
}: {
  scope?: 'instance' | 'compute' | 'all';
}) {
  const queryClient = useQueryClient();
  const { data: session } = useAuthSession();
  const adminSettingsQueryKey = queryKeys.admin(session?.user?.id ?? 'no-session', 'settings');
  const { data, error } = useQuery({
    queryKey: adminSettingsQueryKey,
    queryFn: fetchAdminSettings,
    enabled: Boolean(session?.user?.id),
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
      await queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey });
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
      await queryClient.invalidateQueries({ queryKey: adminSettingsQueryKey });
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
  const playbackBackgroundExtentValue: PlaybackBackgroundExtent =
    draft.ttsPlaybackBackgroundExtent === 'document' ? 'document' : 'section';
  const playbackBackgroundExtentOption = PLAYBACK_BACKGROUND_EXTENT_OPTIONS.find(
    (option) => option.value === playbackBackgroundExtentValue,
  ) ?? PLAYBACK_BACKGROUND_EXTENT_OPTIONS[0];

  const handleProviderChange = (opt: ProviderOption) => {
    updateDraft('defaultTtsProvider', opt.id);
  };

  const computePolicy = parseComputeLimitPolicyDocument(draft.computeLimitPolicies);
  const showInstanceSettings = scope === 'instance' || scope === 'all';
  const showComputeSettings = scope === 'compute' || scope === 'all';

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
      {showInstanceSettings ? <Section
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
            <Select
              value={selectedProviderOption}
              onChange={handleProviderChange}
              options={providerOptions}
              getOptionKey={(option) => option.id}
              renderValue={(option) => option.name}
              renderOption={(option, { selected }) => (
                <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                  {option.name}
                </span>
              )}
              chevronClassName="h-4 w-4 text-muted"
            />
          ) : (
            <div className="px-0.5 py-2 text-sm text-muted">
              No shared providers yet. Add one first.
            </div>
          )}
        </div>

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
      </Section> : null}

      {showComputeSettings ? <Section
        title="Rate limiting"
        subtitle="Direct controls for usage, requests, workers, and TTS providers."
        action={<Badge tone="foreground">Limits</Badge>}
      >
        <div className="space-y-3 px-0.5 py-1.5 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">Compute limits</p>
              <p className="text-xs text-muted mt-0.5">
                Configure each boundary directly. Enabled limits reject new work at the configured threshold.
              </p>
            </div>
            <div className="shrink-0">{renderSource('computeLimitPolicies')}</div>
          </div>
          {computePolicy ? (
            <ComputeLimitsEditor
              policy={computePolicy}
              providers={sharedProviders.map(({ slug, displayName }) => ({ slug, displayName }))}
              onChange={(nextPolicy) => updateDraft('computeLimitPolicies', nextPolicy)}
            />
          ) : null}
          <p className="text-xs text-muted">
            TTS usage is checked per uncached segment. Cached audio and already generated ranges remain available after a limit is reached.
          </p>
        </div>

        <div className="px-0.5 pt-1 pb-2 border-b border-offbase last:border-b-0">
          <div className="flex items-center gap-2.5">
            <div className="flex-1 min-w-0 space-y-0.5">
              <span className="block text-sm font-medium leading-5 text-foreground">Max upload size</span>
              <span className="block text-xs leading-4 text-muted">Largest single document upload accepted.</span>
            </div>
            <div className="shrink-0 self-start pl-1.5">{renderSource('maxUploadMb')}</div>
            <div className="shrink-0 flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                aria-label="Max upload size in megabytes"
                className="w-20 text-right"
                value={String(draft.maxUploadMb ?? '')}
                onChange={(event) => updatePositiveIntDraft('maxUploadMb', event.target.value)}
              />
              <span className="text-xs text-muted">MB</span>
            </div>
          </div>
        </div>
      </Section> : null}

      {showComputeSettings ? <Section
        title="TTS playback"
        subtitle="Worker generation behavior for progressive playback."
        action={<Badge tone="foreground">Playback</Badge>}
      >
        <div className="space-y-1.5 pb-2 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Background generation extent</p>
              <p className="text-xs text-muted mt-0.5">
                How far the worker keeps generating after playback cursor updates stop.
              </p>
            </div>
            <div className="shrink-0">{renderSource('ttsPlaybackBackgroundExtent')}</div>
          </div>
          <Select
            value={playbackBackgroundExtentOption}
            onChange={(option) => updateDraft('ttsPlaybackBackgroundExtent', option.value)}
            options={PLAYBACK_BACKGROUND_EXTENT_OPTIONS}
            getOptionKey={(option) => option.value}
            renderValue={(option) => option.label}
            renderOption={(option, { selected }) => (
              <span className="block">
                <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                  {option.label}
                </span>
                <span className="block truncate text-xs text-muted">
                  {option.description}
                </span>
              </span>
            )}
            chevronClassName="h-4 w-4 text-muted"
          />
        </div>
      </Section> : null}

      {showInstanceSettings ? <Section
        title="Site features"
        subtitle="Feature flags for all users."
        action={<Badge tone="foreground">Feature Flags</Badge>}
      >
        <div className="space-y-1.5 pb-2 border-b border-offbase">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Changelog feed URL</p>
              <p className="text-xs text-muted mt-0.5">
                Public URL used by the standalone changelog page.
              </p>
            </div>
            <div className="shrink-0">{renderSource('changelogFeedUrl')}</div>
          </div>
          <Input
            type="text"
            value={String(draft.changelogFeedUrl ?? '')}
            onChange={(event) => updateDraft('changelogFeedUrl', event.target.value)}
            placeholder="https://docs.openreader.richardr.dev/changelog/manifest.json"
          />
        </div>
        <div className="space-y-2 border-b border-line-soft pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">New account sign-ups</p>
              <p className="mt-0.5 text-xs text-soft">
                Open access, collect requests for approval, or close registration. Approval does not verify email ownership.
              </p>
            </div>
            <div className="shrink-0">{renderSource('signupPolicy')}</div>
          </div>
          <SegmentedControl<SignupPolicy>
            value={draft.signupPolicy === 'approval' || draft.signupPolicy === 'closed' ? draft.signupPolicy : 'open'}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'approval', label: 'Approve' },
              { value: 'closed', label: 'Closed' },
            ]}
            onChange={(value) => updateDraft('signupPolicy', value)}
            ariaLabel="New account sign-up policy"
            className="grid-cols-3"
          />
        </div>
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
      </Section> : null}

      {showComputeSettings ? <Section
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
            <Input
              type="number"
              min={1}
              step={1}
              value={String(draft.ttsUpstreamMaxRetries ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsUpstreamMaxRetries', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Upstream timeout (ms)</label>
              {renderSource('ttsUpstreamTimeoutMs')}
            </div>
            <Input
              type="number"
              min={1}
              step={1}
              value={String(draft.ttsUpstreamTimeoutMs ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsUpstreamTimeoutMs', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Audio cache size (bytes)</label>
              {renderSource('ttsCacheMaxSizeBytes')}
            </div>
            <Input
              type="number"
              min={1}
              step={1}
              value={String(draft.ttsCacheMaxSizeBytes ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsCacheMaxSizeBytes', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">Audio cache TTL (ms)</label>
              {renderSource('ttsCacheTtlMs')}
            </div>
            <Input
              type="number"
              min={1}
              step={1}
              value={String(draft.ttsCacheTtlMs ?? '')}
              onChange={(event) => updatePositiveIntDraft('ttsCacheTtlMs', event.target.value)}
            />
          </div>
        </div>
      </Section> : null}

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
            variant="secondary"
            size="sm"
          >
            Discard
          </Button>
          <Button
            onClick={saveAll}
            disabled={dirty.size === 0 || saving}
            variant="primary"
            size="sm"
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
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onReset}
          disabled={saving}
          className="h-auto px-1 py-0 text-[11px] font-medium text-muted hover:text-accent"
        >
          Reset
        </Button>
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
