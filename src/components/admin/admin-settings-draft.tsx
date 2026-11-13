'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { InlineButton, Input, SaveBar, Section, SettingRow, ToggleRow } from '@/components/ui';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

type RuntimeConfigSource = 'json-seed' | 'env-seed' | 'admin' | 'default';

interface SettingsResponse {
  values: Record<string, unknown>;
  sources: Record<string, RuntimeConfigSource>;
}

async function fetchAdminSettings(): Promise<SettingsResponse> {
  const res = await fetch('/api/admin/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SettingsResponse;
}

interface PatchResult {
  /** Keys the server refused; a 207 means the others were saved. */
  failed: string[];
  /** The settings read back after the write, or null when that read failed. */
  settings: SettingsResponse | null;
}

/** The response carries the settings read fresh from the database after the write. */
async function patchAdminSettings(payload: { updates: Record<string, unknown>; reset?: string[] }): Promise<PatchResult> {
  const res = await fetch('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<SettingsResponse> & { errors?: Array<{ key: string }> };
  return {
    failed: (body.errors ?? []).map(({ key }) => key),
    settings: body.values && body.sources ? { values: body.values, sources: body.sources } : null,
  };
}

/**
 * One admin tab's edits to the shared runtime settings. Every tab reads the same
 * query, keeps its own draft of the keys it shows, and saves them with its own
 * save bar, so an edit never waits on another tab. Edits sit over the
 * fetched values, so a refetch updates untouched keys and keeps unsaved ones.
 */
export function useAdminSettingsDraft() {
  const queryClient = useQueryClient();
  const { data: session } = useAuthSession();
  const queryKey = queryKeys.admin(session?.user?.id ?? 'no-session', 'settings');
  const { data, error } = useQuery({
    queryKey,
    queryFn: fetchAdminSettings,
    enabled: Boolean(session?.user?.id),
  });
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const draft = useMemo(() => ({ ...data?.values, ...edits }), [data, edits]);
  const dirty = useMemo(() => new Set(Object.keys(edits)), [edits]);
  // Values a save is sending, or RESETTING for a key being reset. While a request runs these,
  // not the fetched values, are what an edit undoes; a reset's outcome is unknown, so no edit undoes it.
  const pending = useRef<Record<string, unknown>>({});

  /**
   * Take a request's read-back as the server state: drop edits that now match it, and
   * cache it so the draft is right even if the refetch that follows fails. Without a
   * read-back every edit stays until the user saves or discards it.
   */
  const settle = async ({ settings }: PatchResult, keep: (key: string) => boolean = () => false) => {
    pending.current = {};
    if (settings) {
      queryClient.setQueryData<SettingsResponse>(queryKey, settings);
      setEdits((current) => {
        const kept = Object.fromEntries(Object.entries(current).filter(([key, value]) => (
          keep(key) || !Object.is(value, settings.values[key])
        )));
        return Object.keys(kept).length === Object.keys(current).length ? current : kept;
      });
    }
    await queryClient.invalidateQueries({ queryKey });
  };

  useEffect(() => {
    if (!error) return;
    console.error('[admin settings] load failed:', error);
    toast.error('Failed to load site settings');
  }, [error]);

  const resetMutation = useMutation({
    // Without `updates`, the route reads the whole body as updates and refuses `reset` as a key.
    mutationFn: (key: string) => patchAdminSettings({ updates: {}, reset: [key] }),
    onMutate: (key) => { pending.current = { [key]: RESETTING }; },
    // Reset shows only on keys without an edit, so any edit here was made while it ran.
    onSuccess: async (result) => {
      if (result.failed.length) toast.error('Reset failed');
      else toast.success('Reset to env default');
      await settle(result);
    },
    onError: (mutationError) => {
      pending.current = {};
      console.error(mutationError);
      toast.error('Reset failed');
    },
  });

  const saveMutation = useMutation({
    mutationFn: (updates: Record<string, unknown>) => patchAdminSettings({ updates }),
    onMutate: (updates) => { pending.current = updates; },
    onSuccess: async (result, updates) => {
      const { failed } = result;
      // Refused keys come back to the draft to fix, even if cleared for matching the request.
      setEdits((current) => {
        const restored = { ...current };
        for (const key of failed) if (key in updates && !(key in current)) restored[key] = updates[key];
        return restored;
      });
      if (failed.length) toast.error(`Not saved: ${failed.join(', ')}`);
      else toast.success('Settings saved');
      await settle(result, (key) => failed.includes(key));
    },
    onError: (mutationError, updates) => {
      pending.current = {};
      console.error(mutationError);
      // Nothing was saved, so an edit cleared for matching the request comes back.
      setEdits((current) => ({ ...updates, ...current }));
      toast.error('Save failed');
    },
  });

  const saving = resetMutation.isPending || saveMutation.isPending;

  const update = (key: string, value: unknown) => {
    const base = key in pending.current ? pending.current[key] : data?.values?.[key];
    setEdits((current) => (
      Object.is(value, base) ? without(current, key) : { ...current, [key]: value }
    ));
  };

  const save = () => {
    if (saving || dirty.size === 0) return;
    saveMutation.mutate({ ...edits });
  };

  const discard = () => setEdits({});

  /** Where a value came from, with Reset when it is not the built-in default. */
  const source = (key: string) => {
    if (dirty.has(key)) return <span className="font-medium text-accent">Modified</span>;
    const origin = data?.sources?.[key] ?? 'default';
    if (origin === 'default') return null;
    return (
      <span className="inline-flex items-center gap-1.5">
        {SOURCE_LABELS[origin]}
        <InlineButton onClick={() => { if (!saving) resetMutation.mutate(key); }} disabled={saving} className="hover:text-accent">
          Reset
        </InlineButton>
      </span>
    );
  };

  const toggle = ({ key, label, icon, info }: { key: string; label: string; icon?: ReactNode; info?: ReactNode }) => (
    <ToggleRow
      key={key}
      label={label}
      icon={icon}
      info={info}
      checked={Boolean(draft[key])}
      onChange={(checked) => update(key, checked)}
      meta={source(key)}
      variant="plain"
    />
  );

  const number = ({ key, label, icon, info, description, ariaLabel, unit }: {
    key: string;
    label: string;
    icon: ReactNode;
    info?: ReactNode;
    description?: ReactNode;
    ariaLabel?: string;
    unit?: string;
  }) => (
    <SettingRow key={key} label={label} icon={icon} info={info} description={description} meta={source(key)} controlClassName="w-40">
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          aria-label={ariaLabel ?? label}
          className="text-right"
          value={String(draft[key] ?? '')}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) update(key, Math.max(1, Math.floor(parsed)));
          }}
        />
        {unit ? <span className="w-9 shrink-0 text-xs text-soft">{unit}</span> : null}
      </div>
    </SettingRow>
  );

  const saveBar = dirty.size > 0 || saving
    ? <SaveBar count={dirty.size} saving={saving} onDiscard={discard} onSave={save} />
    : null;

  return { loaded: Boolean(data), draft, update, source, toggle, number, saveBar };
}

const RESETTING = Symbol('resetting');

function without(edits: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...edits };
  delete next[key];
  return next;
}

const SOURCE_LABELS: Record<Exclude<RuntimeConfigSource, 'default'>, string> = {
  'json-seed': 'From seed',
  'env-seed': 'From env',
  admin: 'Set by admin',
};

/** Placeholder cards with the titles a tab will show, while settings load. */
export function AdminSettingsSkeleton({ titles, label }: { titles: string[]; label: string }) {
  return (
    <div className="space-y-5 animate-pulse" aria-label={label} aria-busy="true">
      {titles.map((title) => (
        <Section key={title} title={title} variant="group">
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="h-7 w-7 shrink-0 rounded-md bg-offbase" />
                <div className="h-4 w-40 rounded bg-offbase" />
              </div>
              <div className="h-5 w-9 shrink-0 rounded-pill bg-offbase" />
            </div>
          ))}
        </Section>
      ))}
    </div>
  );
}
