import type { DocumentUploadProgressEvent } from '@/lib/client/api/documents';

export type DocumentUploadTaskPhase =
  | 'queued'
  | 'preparing'
  | 'transferring'
  | 'finalizing'
  | 'processing'
  | 'complete'
  | 'failed';

export type DocumentUploadTask = {
  id: string;
  name: string;
  size: number;
  phase: DocumentUploadTaskPhase;
  transferredBytes: number;
  workerPhase: 'fetching' | 'converting' | 'uploading' | null;
  error: string | null;
};

export type DocumentUploadBatch = {
  id: string;
  folderId: string | null;
  tasks: DocumentUploadTask[];
  startedAt: number;
};

export type DocumentUploadState = {
  batches: DocumentUploadBatch[];
};

export type DocumentUploadSummary = {
  isActive: boolean;
  hasFailures: boolean;
  isComplete: boolean;
  totalFiles: number;
  completedFiles: number;
  progress: number;
  transferredBytes: number;
  totalBytes: number;
  currentFileName: string | null;
  detail: string;
  error: string | null;
};

export type DocumentUploadAction =
  | { type: 'add'; batch: DocumentUploadBatch }
  | { type: 'progress'; batchId: string; event: DocumentUploadProgressEvent }
  | { type: 'failed'; batchId: string; error: string }
  | { type: 'retry'; batchId: string; startedAt: number }
  | { type: 'remove'; batchId: string }
  | { type: 'remove-terminal' };

const ACTIVE_PHASES = new Set<DocumentUploadTaskPhase>([
  'queued',
  'preparing',
  'transferring',
  'finalizing',
  'processing',
]);

function updateTasksForProgress(
  tasks: DocumentUploadTask[],
  event: DocumentUploadProgressEvent,
): DocumentUploadTask[] {
  if (event.phase === 'preparing') {
    return tasks.map((task) => ACTIVE_PHASES.has(task.phase)
      ? { ...task, phase: 'preparing', error: null }
      : task);
  }
  if (event.phase === 'transferring') {
    return tasks.map((task, index) => index === event.sourceIndex
      ? {
          ...task,
          phase: 'transferring',
          transferredBytes: Math.min(task.size, Math.max(0, event.loadedBytes)),
          error: null,
        }
      : task);
  }
  if (event.phase === 'source-complete') {
    return tasks.map((task, index) => index === event.sourceIndex
      ? {
          ...task,
          phase: 'complete',
          transferredBytes: task.size,
          error: null,
        }
      : task);
  }
  if (event.phase === 'finalizing') {
    return tasks.map((task) => ACTIVE_PHASES.has(task.phase)
      ? { ...task, phase: 'finalizing', transferredBytes: task.size, error: null }
      : task);
  }
  if (event.phase === 'processing') {
    return tasks.map((task, index) => index === event.sourceIndex
      ? {
          ...task,
          phase: 'processing',
          transferredBytes: task.size,
          workerPhase: event.workerPhase ?? task.workerPhase,
          error: null,
        }
      : task);
  }
  return tasks.map((task) => ({
    ...task,
    phase: 'complete',
    transferredBytes: task.size,
    error: null,
  }));
}

export function documentUploadReducer(
  state: DocumentUploadState,
  action: DocumentUploadAction,
): DocumentUploadState {
  if (action.type === 'add') {
    return { batches: [...state.batches, action.batch] };
  }
  if (action.type === 'remove') {
    return { batches: state.batches.filter((batch) => batch.id !== action.batchId) };
  }
  if (action.type === 'remove-terminal') {
    return {
      batches: state.batches.filter((batch) => batch.tasks.some((task) => ACTIVE_PHASES.has(task.phase))),
    };
  }

  return {
    batches: state.batches.map((batch) => {
      if (batch.id !== action.batchId) return batch;
      if (action.type === 'progress') {
        return { ...batch, tasks: updateTasksForProgress(batch.tasks, action.event) };
      }
      if (action.type === 'retry') {
        return {
          ...batch,
          startedAt: action.startedAt,
          tasks: batch.tasks.map((task) => ({
            ...task,
            phase: 'queued',
            transferredBytes: 0,
            workerPhase: null,
            error: null,
          })),
        };
      }
      return {
        ...batch,
        tasks: batch.tasks.map((task) => ACTIVE_PHASES.has(task.phase)
          ? { ...task, phase: 'failed', error: action.error }
          : task),
      };
    }),
  };
}

export function createDocumentUploadBatch(
  id: string,
  files: File[],
  folderId?: string,
): DocumentUploadBatch {
  return {
    id,
    folderId: folderId ?? null,
    startedAt: Date.now(),
    tasks: files.map((file, index) => ({
      id: `${id}:${index}`,
      name: file.name || `Document ${index + 1}`,
      size: Math.max(0, file.size),
      phase: 'queued',
      transferredBytes: 0,
      workerPhase: null,
      error: null,
    })),
  };
}

function taskProgress(task: DocumentUploadTask): number {
  if (task.phase === 'complete') return 1;
  if (task.phase === 'queued') return 0;
  if (task.phase === 'preparing') return 0.03;
  if (task.phase === 'transferring') {
    const transferRatio = task.size > 0 ? task.transferredBytes / task.size : 1;
    return 0.05 + Math.min(1, Math.max(0, transferRatio)) * 0.75;
  }
  if (task.phase === 'finalizing') return 0.85;
  if (task.phase === 'processing') {
    if (task.workerPhase === 'uploading') return 0.97;
    if (task.workerPhase === 'converting') return 0.93;
    if (task.workerPhase === 'fetching') return 0.89;
    return 0.87;
  }
  return Math.min(0.99, task.size > 0 ? task.transferredBytes / task.size : 0);
}

function taskDetail(task: DocumentUploadTask): string {
  if (task.phase === 'queued') return 'Queued';
  if (task.phase === 'preparing') return 'Preparing secure upload';
  if (task.phase === 'transferring') return 'Sending to document storage';
  if (task.phase === 'finalizing') return 'Adding to your library';
  if (task.phase === 'processing') {
    if (task.workerPhase === 'fetching') return 'Preparing Word conversion';
    if (task.workerPhase === 'converting') return 'Converting Word document';
    if (task.workerPhase === 'uploading') return 'Saving converted PDF';
    return 'Waiting for document conversion';
  }
  if (task.phase === 'complete') return 'Upload complete';
  return 'Upload failed';
}

export function deriveDocumentUploadSummary(
  state: DocumentUploadState,
): DocumentUploadSummary | null {
  const batches = [...state.batches].sort((a, b) => a.startedAt - b.startedAt);
  const tasks = batches.flatMap((batch) => batch.tasks);
  if (tasks.length === 0) return null;

  const activeTasks = tasks.filter((task) => ACTIVE_PHASES.has(task.phase));
  const failedTasks = tasks.filter((task) => task.phase === 'failed');
  const completedFiles = tasks.filter((task) => task.phase === 'complete').length;
  const currentTask = activeTasks[0] ?? failedTasks[0] ?? tasks[tasks.length - 1] ?? null;
  const totalWeight = tasks.reduce((sum, task) => sum + Math.max(1, task.size), 0);
  const weightedProgress = tasks.reduce(
    (sum, task) => sum + taskProgress(task) * Math.max(1, task.size),
    0,
  );
  const progress = totalWeight > 0 ? Math.round((weightedProgress / totalWeight) * 100) : 0;

  return {
    isActive: activeTasks.length > 0,
    hasFailures: failedTasks.length > 0,
    isComplete: completedFiles === tasks.length,
    totalFiles: tasks.length,
    completedFiles,
    progress: failedTasks.length > 0 ? Math.min(99, progress) : progress,
    transferredBytes: tasks.reduce((sum, task) => sum + task.transferredBytes, 0),
    totalBytes: tasks.reduce((sum, task) => sum + task.size, 0),
    currentFileName: currentTask?.name ?? null,
    detail: currentTask ? taskDetail(currentTask) : 'Uploading',
    error: failedTasks[0]?.error ?? null,
  };
}
