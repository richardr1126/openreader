'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button, InfoTip, Input, RowIcon, SaveBar, Section, Switch } from '@/components/ui';
import {
  ClockIcon, HeadphonesIcon, RefreshIcon, SlidersIcon, TrashIcon, UploadIcon, WrenchIcon,
} from '@/components/icons/Icons';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

type TaskRunStatus = 'idle' | 'running' | 'ok' | 'error';

interface TaskView {
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  intervalMs: number;
  lastStatus: TaskRunStatus;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: string | null;
  nextRunAt: number | null;
  running: boolean;
}

interface TaskSchedulerInfo {
  mode: 'self-hosted' | 'vercel-cron';
  tickIntervalMs: number;
  minimumIntervalMs: number;
}

async function fetchTasks(): Promise<{ tasks: TaskView[]; scheduler: TaskSchedulerInfo }> {
  const res = await fetch('/api/admin/tasks');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { tasks: TaskView[]; scheduler: TaskSchedulerInfo };
}

const TASK_ICONS: Record<string, ReactNode> = {
  'reap-orphaned-blobs': <TrashIcon />,
  'cleanup-temp-uploads': <UploadIcon />,
  'expire-export-artifacts': <HeadphonesIcon />,
  'prune-compute-limits': <SlidersIcon />,
};

function RunningDot() {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center" title="Running" aria-label="Running">
      <span className="absolute inline-flex size-2 animate-ping rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

function formatRelative(ms: number | null): string {
  if (ms == null) return 'never';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  let label = 'now';
  for (const [unitMs, suffix] of units) {
    if (abs >= unitMs) {
      label = `${Math.round(abs / unitMs)}${suffix}`;
      break;
    }
  }
  if (label === 'now') return 'just now';
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AdminTasksPanel() {
  const queryClient = useQueryClient();
  const { data: session } = useAuthSession();
  const tasksQueryKey = queryKeys.admin(session?.user?.id ?? 'no-session', 'tasks');
  const { data, error, isPending: isLoading } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: fetchTasks,
    enabled: Boolean(session?.user?.id),
    refetchInterval: (query) => (
      query.state.data?.tasks.some((task) => task.running) ? 2_000 : 30_000
    ),
  });

  useEffect(() => {
    if (!error) return;
    console.error('[AdminTasksPanel] load failed:', error);
    toast.error('Failed to load tasks');
  }, [error]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: tasksQueryKey });

  // Interval edits wait for the save bar; switches and Run now act at once.
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const minimumIntervalMs = data?.scheduler.minimumIntervalMs ?? 60_000;
  const dirtyIntervals = (data?.tasks ?? []).flatMap((task) => {
    const draft = intervalDrafts[task.key];
    if (draft === undefined) return [];
    const intervalMs = parseFloat(draft) * 60000;
    return Number.isFinite(intervalMs) && intervalMs >= minimumIntervalMs && intervalMs !== task.intervalMs
      ? [{ key: task.key, intervalMs }]
      : [];
  });

  const patchTask = useMutation({
    mutationFn: async ({ key, patch }: { key: string; patch: { enabled?: boolean; intervalMs?: number } }) => {
      const res = await fetch(`/api/admin/tasks/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
    onError: () => toast.error('Update failed'),
  });

  const saveIntervals = useMutation({
    mutationFn: async (changes: Array<{ key: string; intervalMs: number }>) => {
      for (const { key, intervalMs } of changes) {
        const res = await fetch(`/api/admin/tasks/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intervalMs }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setIntervalDrafts({});
      toast.success('Task intervals saved');
    },
    onError: () => {
      toast.error('Save failed');
      void invalidate();
    },
  });

  const runTask = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/admin/tasks/${encodeURIComponent(key)}/run`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { ran: boolean }).ran;
    },
    onSuccess: (ran) => {
      toast.success(ran ? 'Task ran' : 'Task already running');
      invalidate();
    },
    onError: () => toast.error('Run failed'),
  });

  return (
    <>
      <Section
        variant="group"
        title="Scheduled tasks"
        footer={data?.scheduler.mode === 'vercel-cron'
          ? 'Vercel Hobby runs scheduled tasks once daily, so shorter intervals do not apply here.'
          : undefined}
      >
        {isLoading ? (
          <TasksSkeleton />
        ) : (
          <ul className="divide-y divide-line-soft !p-0">
            {(data?.tasks ?? []).map((task) => (
              <TaskRow
                key={task.key}
                task={task}
                schedulerMode={data?.scheduler.mode ?? 'self-hosted'}
                minimumIntervalMs={minimumIntervalMs}
                minutes={intervalDrafts[task.key] ?? String(task.intervalMs / 60000)}
                onMinutesChange={(minutes) => setIntervalDrafts((current) => ({ ...current, [task.key]: minutes }))}
                busy={patchTask.isPending || runTask.isPending || saveIntervals.isPending}
                runPending={runTask.isPending && runTask.variables === task.key}
                onToggle={(enabled) => patchTask.mutate({ key: task.key, patch: { enabled } })}
                onRun={() => runTask.mutate(task.key)}
              />
            ))}
            {data && data.tasks.length === 0 && (
              <li className="text-sm text-soft">No maintenance tasks registered.</li>
            )}
          </ul>
        )}
      </Section>
      {dirtyIntervals.length > 0 || saveIntervals.isPending ? (
        <SaveBar
          count={dirtyIntervals.length}
          saving={saveIntervals.isPending}
          onDiscard={() => setIntervalDrafts({})}
          onSave={() => saveIntervals.mutate(dirtyIntervals)}
        />
      ) : null}
    </>
  );
}

function TasksSkeleton() {
  const rows = Array.from({ length: 2 });
  return (
    <div
      className="animate-pulse divide-y divide-line-soft !p-0"
      aria-label="Loading maintenance tasks"
      aria-busy="true"
    >
      {rows.map((_, index) => (
        <div key={index} className="space-y-2 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-7 w-7 rounded-md bg-offbase" />
              <div className="h-4 w-48 rounded bg-offbase" />
            </div>
            <div className="h-5 w-9 rounded-pill bg-offbase" />
          </div>
          <div className="ml-10 h-6 w-64 rounded bg-offbase" />
        </div>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  schedulerMode,
  minimumIntervalMs,
  minutes,
  onMinutesChange,
  busy,
  runPending,
  onToggle,
  onRun,
}: {
  task: TaskView;
  schedulerMode: TaskSchedulerInfo['mode'];
  minimumIntervalMs: number;
  minutes: string;
  onMinutesChange: (minutes: string) => void;
  busy: boolean;
  runPending: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
}) {
  const running = task.running || runPending;

  const about = [task.description, task.lastStatus === 'ok' ? task.lastResult : null].filter(Boolean);

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <RowIcon>{TASK_ICONS[task.key] ?? <WrenchIcon />}</RowIcon>
          <span className="truncate text-sm font-medium text-foreground">{task.name}</span>
          {about.length > 0 ? (
            <InfoTip label={task.name}>
              {about.map((line) => <p key={line} className="[&+p]:mt-1.5">{line}</p>)}
            </InfoTip>
          ) : null}
          {running && <RunningDot />}
        </span>
        <Switch checked={task.enabled} onChange={onToggle} ariaLabel={`Enable ${task.name}`} disabled={busy} />
      </div>

      <div className="ml-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs text-soft">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1" title={`Ran in ${formatDuration(task.lastDurationMs)}`}>
            <ClockIcon className="size-3 text-faint" aria-hidden />
            <span className="sr-only">Last run </span>
            {formatRelative(task.lastRunAt)}
          </span>
          {task.enabled && (schedulerMode === 'vercel-cron' || task.nextRunAt != null) && (
            <span className="inline-flex items-center gap-1 text-faint">
              <RefreshIcon className="size-3" />
              {schedulerMode === 'vercel-cron' ? 'next daily cron' : `next ${formatRelative(task.nextRunAt)}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-faint">
          <span>Every</span>
          <Input
            type="number"
            min={minimumIntervalMs / 60000}
            step="any"
            controlSize="sm"
            className="!w-16 text-center"
            value={minutes}
            onChange={(e) => onMinutesChange(e.target.value)}
            aria-label={`${task.name} interval in minutes`}
          />
          <span>min</span>
          <Button variant="outline" size="xs" className="whitespace-nowrap" onClick={onRun} disabled={busy || running}>
            {running ? 'Running…' : 'Run now'}
          </Button>
        </div>
      </div>

      {task.lastStatus === 'error' && task.lastError ? (
        <p className="ml-10 truncate text-xs text-danger" title={task.lastError}>{task.lastError}</p>
      ) : null}
    </li>
  );
}
