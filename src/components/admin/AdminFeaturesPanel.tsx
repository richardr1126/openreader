'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Transition,
} from '@headlessui/react';
import toast from 'react-hot-toast';
import { ChevronUpDownIcon, CheckIcon } from '@/components/icons/Icons';
import {
  Badge,
  Card,
  Section,
  ToggleRow,
  btnPrimary,
  btnSecondary,
} from '@/components/admin/ui';
import { type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { useSharedProviders, type SharedProviderEntry } from '@/hooks/useSharedProviders';

type RuntimeConfigSource = 'env-seed' | 'admin' | 'default';

interface SettingsResponse {
  values: Record<string, unknown>;
  sources: Record<string, RuntimeConfigSource>;
}

interface ProviderOption {
  id: string;
  name: string;
  providerType: TtsProviderId;
  shared: boolean;
}

export function AdminFeaturesPanel() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { providers: sharedProviders } = useSharedProviders();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as SettingsResponse;
      setData(next);
      setDraft({ ...next.values });
      setDirty(new Set());
    } catch (error) {
      console.error('[AdminFeaturesPanel] load failed:', error);
      toast.error('Failed to load site settings');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateDraft = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty((s) => {
      const next = new Set(s);
      next.add(key);
      return next;
    });
  };

  const resetField = async (key: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: [key] }),
      });
      if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
      toast.success('Reset to env default');
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error('Reset failed');
    } finally {
      setSaving(false);
    }
  };

  const saveAll = async () => {
    if (saving || dirty.size === 0) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      for (const key of dirty) updates[key] = draft[key];
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
      toast.success('Settings saved');
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const discardAll = () => {
    if (!data) return;
    setDraft({ ...data.values });
    setDirty(new Set());
  };

  // --- Provider option resolution ---

  const providerOptions = useMemo<ProviderOption[]>(() => {
    return sharedProviders.map((entry) => ({
      id: entry.slug,
      name: `${entry.displayName} (shared)`,
      providerType: entry.providerType,
      shared: true,
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
      shared: true,
    } as ProviderOption
    : fallbackShared;
  const selectedProviderOption = effectiveSelectedProvider;

  const handleProviderChange = (opt: ProviderOption) => {
    updateDraft('defaultTtsProvider', opt.id);
  };

  // --- Renderers ---

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
      <Section title="TTS defaults" subtitle="Loading…">
        <p className="text-xs text-muted">Fetching current values…</p>
      </Section>
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="TTS defaults"
        subtitle="What new users start with."
      >
        {/* Provider picker */}
        <Card className="space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Default TTS provider</p>
              <p className="text-xs text-muted mt-0.5">
                Initial selection for new users. Model and instructions come from that shared provider configuration.
              </p>
            </div>
            <div className="shrink-0">{renderSource('defaultTtsProvider')}</div>
          </div>
          {providerOptions.length > 0 ? (
            <Listbox value={selectedProviderOption} onChange={handleProviderChange}>
              <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-base border border-offbase py-1.5 pl-3 pr-10 text-left text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent hover:bg-offbase hover:text-accent transition-colors">
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
                <ListboxOptions
                  anchor="bottom start"
                  className="z-50 w-[var(--button-width)] max-h-60 overflow-y-auto overscroll-contain rounded-md bg-background py-1 shadow-lg ring-1 ring-offbase focus:outline-none [--anchor-gap:0.25rem]"
                >
                  {providerOptions.map((opt) => (
                    <ListboxOption
                      key={opt.id}
                      value={opt}
                      className={({ active }) =>
                        `relative cursor-pointer select-none py-2 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'}`
                      }
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
            <div className="rounded-lg border border-offbase bg-base px-3 py-2 text-sm text-muted">
              No shared providers configured. Add one in the Shared providers tab first.
            </div>
          )}
        </Card>

        {/* Boolean TTS toggles */}
        <ToggleRow
          label="Restrict user API keys (recommended)"
          description="When on, users cannot supply personal API keys/base URLs; TTS requests must use admin-configured shared providers."
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
        />
        <ToggleRow
          label="Show TTS provider settings tab"
          description="Lets users override the provider / API key per-user. Turn off to lock everyone to admin-configured shared default provider and model."
          checked={Boolean(draft.enableTtsProvidersTab)}
          onChange={(checked) => updateDraft('enableTtsProvidersTab', checked)}
          right={renderSource('enableTtsProvidersTab')}
        />
        <ToggleRow
          label="Show all Deepinfra models"
          description="When off, restricts the Deepinfra picker to the free Kokoro-only subset for users without API keys."
          checked={Boolean(draft.showAllDeepInfraModels)}
          onChange={(checked) => updateDraft('showAllDeepInfraModels', checked)}
          right={renderSource('showAllDeepInfraModels')}
        />
        <ToggleRow
          label="Show all provider models"
          description="When off, users are restricted to each provider's default model."
          checked={Boolean(draft.showAllProviderModels)}
          onChange={(checked) => updateDraft('showAllProviderModels', checked)}
          right={renderSource('showAllProviderModels')}
        />
      </Section>

      <Section
        title="Site features"
        subtitle="Toggle features site-wide. Changes take effect for all users on the next page load."
      >
        <ToggleRow
          label="Word-level highlighting"
          description="Use whisper.cpp alignment for word-by-word highlighting during TTS playback."
          checked={Boolean(draft.enableWordHighlight)}
          onChange={(checked) => updateDraft('enableWordHighlight', checked)}
          right={renderSource('enableWordHighlight')}
        />
        <ToggleRow
          label="Audiobook export"
          description='Show the "Export audiobook" feature on PDF / EPUB pages.'
          checked={Boolean(draft.enableAudiobookExport)}
          onChange={(checked) => updateDraft('enableAudiobookExport', checked)}
          right={renderSource('enableAudiobookExport')}
        />
        <ToggleRow
          label="DOCX upload conversion"
          description="Accept .docx files in the document uploader (converted to PDF server-side)."
          checked={Boolean(draft.enableDocxConversion)}
          onChange={(checked) => updateDraft('enableDocxConversion', checked)}
          right={renderSource('enableDocxConversion')}
        />
        <ToggleRow
          label="Destructive delete buttons"
          description='Show "Delete all data" actions in the Documents tab (auth-disabled mode only).'
          checked={Boolean(draft.enableDestructiveDeleteActions)}
          onChange={(checked) => updateDraft('enableDestructiveDeleteActions', checked)}
          right={renderSource('enableDestructiveDeleteActions')}
        />
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
            className={`${btnSecondary} px-4 py-1.5`}
          >
            Discard
          </Button>
          <Button
            onClick={saveAll}
            disabled={dirty.size === 0 || saving}
            className={`${btnPrimary} px-4 py-1.5`}
          >
            {saving ? 'Saving…' : dirty.size > 0 ? `Save (${dirty.size})` : 'Save'}
          </Button>
        </div>
      </div>
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
