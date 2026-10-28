/** Outcome a task handler may return; surfaced in the admin UI as a summary. */
export type TaskResult = {
  /** Short human-readable summary, e.g. "Reaped 3 orphaned blobs". */
  summary?: string;
  /** Where a bounded run stopped; handed back as `context.cursor` next run. */
  cursor?: string;
  /** Turn the task off after this run (a one-time task that has finished). */
  disableTask?: boolean;
  /** Arbitrary structured detail for debugging. */
  [key: string]: unknown;
};

export type TaskContext = {
  signal: AbortSignal;
  deadlineAt: number;
  /** Cursor the previous successful run returned, if any. */
  cursor: string | null;
};

export type TaskHandler = (context: TaskContext) => Promise<TaskResult | void>;

/** Static definition of a task, kept in code (the registry). */
export type TaskDef = {
  /** Display name shown in the admin tasks list. */
  name: string;
  /** Optional longer description of what the task does. */
  description?: string;
  /** Default run interval in ms; the per-task row may override it. */
  defaultIntervalMs: number;
  /** Whether a newly seeded task row starts enabled (default true). */
  defaultEnabled?: boolean;
  /** Maximum wall-clock time before the run is marked failed and aborted. */
  maxRunMs?: number;
  /** The work to perform. Must be idempotent and safe to re-run. */
  run: TaskHandler;
};

export type TaskRegistry = Record<string, TaskDef>;

export type TaskRunStatus = 'idle' | 'running' | 'ok' | 'error';
