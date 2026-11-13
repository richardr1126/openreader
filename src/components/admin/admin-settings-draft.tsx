'use client';

import { useEffect, useState, type ReactNode } from 'react';
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

async function patchAdminSettings(payload: { updates?: Record<string, unknown>; reset?: string[] }): Promise<void> {
  const res = await fetch('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
}

/**
 * One admin tab's edits to the shared runtime settings. Every tab reads the same
 * query, keeps its own draft of the keys it shows, and saves them with its own
 * save bar, so an edit never waits on another tab.
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
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!data) return;
    setDraft({ ...data.values });
    setDirty(new Set());
  }, [data]);

  useEffect(() => {
    if (!error) return;
    console.error('[admin settings] load failed:', error);
    toast.error('Failed to load site settings');
  }, [error]);

  const resetMutation = useMutation({
    mutationFn: (key: string) => patchAdminSettings({ reset: [key] }),
    onSuccess: async () => {
      toast.success('Reset to env default');
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (mutationError) => {
      console.error(mutationError);
      toast.error('Reset failed');
    },
  });

  const saveMutation = useMutation({
    mutationFn: (updates: Record<string, unknown>) => patchAdminSettings({ updates }),
    onSuccess: async () => {
      toast.success('Settings saved');
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (mutationError) => {
      console.error(mutationError);
      toast.error('Save failed');
    },
  });

  const saving = resetMutation.isPending || saveMutation.isPending;

  const update = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty((s) => {
      const next = new Set(s);
      if (Object.is(value, data?.values?.[key])) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = () => {
    if (saving || dirty.size === 0) return;
    const updates: Record<string, unknown> = {};
    for (const key of dirty) updates[key] = draft[key];
    saveMutation.mutate(updates);
  };

  const discard = () => {
    if (!data) return;
    setDraft({ ...data.values });
    setDirty(new Set());
  };

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
