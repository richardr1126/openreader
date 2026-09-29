'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Section,
  SettingRow,
  ToggleRow,
  Select,
  SegmentedControl,
  Button,
  InlineButton,
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

  const numberRow = ({ key, label, ariaLabel, unit }: {
    key: string;
    label: string;
    ariaLabel?: string;
    unit?: string;
  }) => (
    <SettingRow label={label} meta={renderSource(key)} controlClassName="w-40">
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          aria-label={ariaLabel ?? label}
          className="text-right"
          value={String(draft[key] ?? '')}
          onChange={(event) => updatePositiveIntDraft(key, event.target.value)}
        />
        {unit ? <span className="w-9 shrink-0 text-xs text-soft">{unit}</span> : null}
      </div>
    </SettingRow>
  );

  return (
    <div className="space-y-5">
      {showInstanceSettings ? <Section title="TTS defaults" variant="group">
        <SettingRow
          label="Default TTS provider"
          description="Starting provider for new users."
          meta={renderSource('defaultTtsProvider')}
          controlClassName="w-56"
        >
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
            <p className="text-xs text-soft">No shared providers yet. Add one first.</p>
          )}
        </SettingRow>
        <ToggleRow
          label="Show TTS provider settings tab"
          description="Allow per-user provider overrides."
          checked={Boolean(draft.enableTtsProvidersTab)}
          onChange={(checked) => updateDraft('enableTtsProvidersTab', checked)}
          meta={renderSource('enableTtsProvidersTab')}
          variant="plain"
        />
        <ToggleRow
          label="Show all provider models"
          description="Allow model selection beyond defaults."
          checked={Boolean(draft.showAllProviderModels)}
          onChange={(checked) => updateDraft('showAllProviderModels', checked)}
          meta={renderSource('showAllProviderModels')}
          variant="plain"
        />
      </Section> : null}

      {showInstanceSettings ? <Section title="Site features" variant="group">
        <SettingRow
          label="Changelog feed URL"
          description="Public URL used by the standalone changelog page."
          meta={renderSource('changelogFeedUrl')}
          stacked
        >
          <Input
            type="text"
            aria-label="Changelog feed URL"
            value={String(draft.changelogFeedUrl ?? '')}
            onChange={(event) => updateDraft('changelogFeedUrl', event.target.value)}
            placeholder="https://docs.openreader.richardr.dev/changelog/manifest.json"
          />
        </SettingRow>
        <SettingRow
          label="New account sign-ups"
          description="Open access, collect requests for approval, or close registration. Approval does not verify email ownership."
          meta={renderSource('signupPolicy')}
          stacked
        >
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
        </SettingRow>
        <ToggleRow
          label="Audiobook export"
          description='Show "Export audiobook" on PDF/EPUB pages.'
          checked={Boolean(draft.enableAudiobookExport)}
          onChange={(checked) => updateDraft('enableAudiobookExport', checked)}
          meta={renderSource('enableAudiobookExport')}
          variant="plain"
        />
        <ToggleRow
          label="DOCX upload conversion"
          description="Allow DOCX uploads (converted to PDF)."
          checked={Boolean(draft.enableDocxConversion)}
          onChange={(checked) => updateDraft('enableDocxConversion', checked)}
          meta={renderSource('enableDocxConversion')}
          variant="plain"
        />
      </Section> : null}

      {showComputeSettings ? <Section
        title="Limits"
        variant="group"
        subtitle="Enabled limits reject new work at the configured threshold. TTS usage is checked per uncached segment; cached audio stays available after a limit is reached."
        action={renderSource('computeLimitPolicies')}
      >
        {numberRow({ key: 'maxUploadMb', label: 'Max upload size', ariaLabel: 'Max upload size in megabytes', unit: 'MB' })}
        {computePolicy ? (
          <ComputeLimitsEditor
            policy={computePolicy}
            providers={sharedProviders.map(({ slug, displayName }) => ({ slug, displayName }))}
            onChange={(nextPolicy) => updateDraft('computeLimitPolicies', nextPolicy)}
          />
        ) : null}
      </Section> : null}

      {showComputeSettings ? <Section title="TTS generation" variant="group">
        <SettingRow
          label="Background generation"
          description="How far the worker keeps generating after playback cursor updates stop."
          meta={renderSource('ttsPlaybackBackgroundExtent')}
          controlClassName="w-52"
        >
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
                <span className="block text-xs text-muted">
                  {option.description}
                </span>
              </span>
            )}
            chevronClassName="h-4 w-4 text-muted"
          />
        </SettingRow>
        {numberRow({ key: 'ttsUpstreamMaxRetries', label: 'Retry attempts' })}
        {numberRow({ key: 'ttsUpstreamTimeoutMs', label: 'Upstream timeout', unit: 'ms' })}
        {numberRow({ key: 'ttsCacheMaxSizeBytes', label: 'Audio cache size', unit: 'bytes' })}
        {numberRow({ key: 'ttsCacheTtlMs', label: 'Audio cache TTL', unit: 'ms' })}
      </Section> : null}

      {dirty.size > 0 || saving ? (
        <div className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-solid px-3 py-2 shadow-elev-3">
          <p className="text-xs text-soft">
            {dirty.size} unsaved change{dirty.size === 1 ? '' : 's'}
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
              {saving ? 'Saving…' : `Save (${dirty.size})`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdminFeaturesSkeleton() {
  return (
    <div className="space-y-5 animate-pulse" aria-label="Loading feature settings" aria-busy="true">
      {['TTS defaults', 'Site features'].map((title) => (
        <Section key={title} title={title} variant="group">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="h-4 w-40 rounded bg-offbase" />
                <div className="h-3 w-56 rounded bg-offbase" />
              </div>
              <div className="h-5 w-9 shrink-0 rounded-pill bg-offbase" />
            </div>
          ))}
        </Section>
      ))}
    </div>
  );
}

const SOURCE_LABELS: Partial<Record<RuntimeConfigSource, string>> = {
  'json-seed': 'From seed',
  'env-seed': 'From env',
  admin: 'Set by admin',
};

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
  if (dirty) return <span className="font-medium text-accent">Modified</span>;
  const label = SOURCE_LABELS[source];
  if (!label && !canReset) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {canReset ? (
        <InlineButton onClick={onReset} disabled={saving} className="hover:text-accent">
          Reset
        </InlineButton>
      ) : null}
    </span>
  );
}
