/** Outcome a task handler may return; surfaced in the admin UI as a summary. */
export type TaskResult = {
  /** Short human-readable summary, e.g. "Reaped 3 orphaned blobs". */
  summary?: string;
  /** Arbitrary structured detail for debugging. */
  [key: string]: unknown;
};

export type TaskHandler = () => Promise<TaskResult | void>;

/** Static definition of a task, kept in code (the registry). */
export type TaskDef = {
  /** Display name shown in the admin tasks list. */
  name: string;
  /** Optional longer description of what the task does. */
  description?: string;
  /** Default run interval in ms; the per-task row may override it. */
  defaultIntervalMs: number;
  /** The work to perform. Must be idempotent and safe to re-run. */
  run: TaskHandler;
};

export type TaskRegistry = Record<string, TaskDef>;

export type TaskRunStatus = 'idle' | 'running' | 'ok' | 'error';
