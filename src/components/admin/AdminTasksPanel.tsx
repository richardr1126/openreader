'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button, Card, Input, Section, Switch } from '@/components/ui';
import { ClockIcon, RefreshIcon } from '@/components/icons/Icons';

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

const TASKS_QUERY_KEY = ['admin-tasks'] as const;

async function fetchTasks(): Promise<{ tasks: TaskView[]; scheduler: TaskSchedulerInfo }> {
  const res = await fetch('/api/admin/tasks');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { tasks: TaskView[]; scheduler: TaskSchedulerInfo };
}

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
  const { data, error, isPending: isLoading } = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!error) return;
    console.error('[AdminTasksPanel] load failed:', error);
    toast.error('Failed to load tasks');
  }, [error]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });

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
    <Section title="Scheduled tasks" subtitle="Background maintenance jobs. Run them on demand or adjust their schedule.">
      {data?.scheduler.mode === 'vercel-cron' && (
        <p className="mb-2 text-xs text-soft">
          Vercel Hobby invokes scheduled tasks once daily. Shorter intervals are unavailable on this deployment.
        </p>
      )}
      {isLoading ? (
        <TasksSkeleton />
      ) : (
        <div className="space-y-2">
          {(data?.tasks ?? []).map((task) => (
            <TaskRow
              key={task.key}
              task={task}
              schedulerMode={data?.scheduler.mode ?? 'self-hosted'}
              minimumIntervalMs={data?.scheduler.minimumIntervalMs ?? 60_000}
              busy={patchTask.isPending || runTask.isPending}
              runPending={runTask.isPending && runTask.variables === task.key}
              onToggle={(enabled) => patchTask.mutate({ key: task.key, patch: { enabled } })}
              onSaveInterval={(intervalMs) => patchTask.mutate({ key: task.key, patch: { intervalMs } })}
              onRun={() => runTask.mutate(task.key)}
            />
          ))}
          {data && data.tasks.length === 0 && (
            <p className="text-sm text-soft">No tasks registered.</p>
          )}
        </div>
      )}
    </Section>
  );
}

function TasksSkeleton() {
  const rows = Array.from({ length: 2 });
  return (
    <div className="space-y-2 animate-pulse" aria-label="Loading scheduled tasks" aria-busy="true">
      {rows.map((_, index) => (
        <Card key={index}>
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="h-4 w-48 rounded bg-offbase" />
                <div className="h-3 w-64 rounded bg-offbase" />
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <div className="h-5 w-9 rounded-pill bg-offbase" />
                <div className="h-8 w-20 rounded-md bg-offbase" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="h-3 w-24 rounded bg-offbase" />
              <div className="h-7 w-28 rounded-md bg-offbase" />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  schedulerMode,
  minimumIntervalMs,
  busy,
  runPending,
  onToggle,
  onSaveInterval,
  onRun,
}: {
  task: TaskView;
  schedulerMode: TaskSchedulerInfo['mode'];
  minimumIntervalMs: number;
  busy: boolean;
  runPending: boolean;
  onToggle: (enabled: boolean) => void;
  onSaveInterval: (intervalMs: number) => void;
  onRun: () => void;
}) {
  const [minutes, setMinutes] = useState(String(task.intervalMs / 60000));

  useEffect(() => {
    setMinutes(String(task.intervalMs / 60000));
  }, [task.intervalMs]);

  const parsedMinutes = parseFloat(minutes);
  const newIntervalMs = parsedMinutes * 60000;
  const intervalDirty =
    Number.isFinite(parsedMinutes)
    && newIntervalMs >= minimumIntervalMs
    && newIntervalMs !== task.intervalMs;

  const running = task.running || runPending;

  return (
    <Card>
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {running && <RunningDot />}
              <span className="truncate text-sm font-medium text-foreground">{task.name}</span>
            </div>
            {task.description && <p className="mt-0.5 text-xs text-soft">{task.description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch checked={task.enabled} onChange={onToggle} ariaLabel={`Enable ${task.name}`} disabled={busy} />
            <Button variant="outline" size="sm" onClick={onRun} disabled={busy || running}>
              {running ? 'Running…' : 'Run now'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-soft">
            <span
              className="inline-flex items-center gap-1"
              title={`Ran in ${formatDuration(task.lastDurationMs)}`}
            >
              <ClockIcon className="size-3 text-faint" />
              {formatRelative(task.lastRunAt)}
            </span>
            {task.enabled && schedulerMode === 'vercel-cron' && (
              <span className="inline-flex items-center gap-1 text-faint">
                <RefreshIcon className="size-3" />
                next daily cron
              </span>
            )}
            {task.enabled && schedulerMode !== 'vercel-cron' && task.nextRunAt != null && (
              <span className="inline-flex items-center gap-1 text-faint">
                <RefreshIcon className="size-3" />
                next {formatRelative(task.nextRunAt)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-faint">
            <span>Every</span>
            <Input
              type="number"
              min={minimumIntervalMs / 60000}
              step="any"
              controlSize="sm"
              className="w-14 text-center"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-label={`${task.name} interval in minutes`}
            />
            <span>min</span>
            {intervalDirty && (
              <Button variant="primary" size="xs" onClick={() => onSaveInterval(newIntervalMs)} disabled={busy}>
                Save
              </Button>
            )}
          </div>
        </div>

        {task.lastStatus === 'error' && task.lastError ? (
          <p className="truncate text-xs text-danger" title={task.lastError}>{task.lastError}</p>
        ) : (
          task.lastStatus === 'ok' && task.lastResult && (
            <p className="truncate text-xs text-faint" title={task.lastResult}>{task.lastResult}</p>
          )
        )}
      </div>
    </Card>
  );
}
