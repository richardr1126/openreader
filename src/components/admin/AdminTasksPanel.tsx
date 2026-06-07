'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Badge, Button, Input, Section, Switch } from '@/components/ui';
import type { BadgeTone } from '@/components/ui/badge';

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

const TASKS_QUERY_KEY = ['admin-tasks'] as const;

async function fetchTasks(): Promise<TaskView[]> {
  const res = await fetch('/api/admin/tasks');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { tasks: TaskView[] }).tasks;
}

const STATUS_TONE: Record<TaskRunStatus, BadgeTone> = {
  idle: 'muted',
  running: 'accent',
  ok: 'foreground',
  error: 'danger',
};

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
  const { data, error } = useQuery({
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
      <div className="space-y-2">
        {(data ?? []).map((task) => (
          <TaskRow
            key={task.key}
            task={task}
            busy={patchTask.isPending || runTask.isPending}
            onToggle={(enabled) => patchTask.mutate({ key: task.key, patch: { enabled } })}
            onSaveInterval={(intervalMs) => patchTask.mutate({ key: task.key, patch: { intervalMs } })}
            onRun={() => runTask.mutate(task.key)}
          />
        ))}
        {data && data.length === 0 && (
          <p className="text-sm text-soft">No tasks registered.</p>
        )}
      </div>
    </Section>
  );
}

function TaskRow({
  task,
  busy,
  onToggle,
  onSaveInterval,
  onRun,
}: {
  task: TaskView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onSaveInterval: (intervalMs: number) => void;
  onRun: () => void;
}) {
  const [minutes, setMinutes] = useState(String(Math.round(task.intervalMs / 60000)));

  useEffect(() => {
    setMinutes(String(Math.round(task.intervalMs / 60000)));
  }, [task.intervalMs]);

  const parsedMinutes = Number(minutes);
  const intervalDirty =
    Number.isFinite(parsedMinutes) && parsedMinutes > 0 && parsedMinutes * 60000 !== task.intervalMs;

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{task.name}</span>
            <Badge tone={STATUS_TONE[task.lastStatus]}>{task.lastStatus}</Badge>
          </div>
          {task.description && <p className="text-xs text-soft mt-0.5">{task.description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={task.enabled} onChange={onToggle} ariaLabel={`Enable ${task.name}`} disabled={busy} />
          <Button variant="outline" size="sm" onClick={onRun} disabled={busy || task.running}>
            {task.running ? 'Running…' : 'Run now'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-soft">
        <span>Last run: {formatRelative(task.lastRunAt)}</span>
        <span>Duration: {formatDuration(task.lastDurationMs)}</span>
        <span>Next run: {task.enabled ? formatRelative(task.nextRunAt) : 'disabled'}</span>
        <span className="flex items-center gap-1">
          Every
          <Input
            type="number"
            min={1}
            controlSize="sm"
            className="w-16"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label={`${task.name} interval in minutes`}
          />
          min
          {intervalDirty && (
            <Button
              variant="primary"
              size="xs"
              onClick={() => onSaveInterval(Math.floor(parsedMinutes) * 60000)}
              disabled={busy}
            >
              Save
            </Button>
          )}
        </span>
      </div>

      {task.lastStatus === 'error' && task.lastError && (
        <p className="text-xs text-danger truncate" title={task.lastError}>{task.lastError}</p>
      )}
      {task.lastStatus === 'ok' && task.lastResult && (
        <p className="text-xs text-soft truncate" title={task.lastResult}>{task.lastResult}</p>
      )}
    </div>
  );
}
