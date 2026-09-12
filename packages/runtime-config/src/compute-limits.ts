export const COMPUTE_ACTIONS = [
  'pdf_layout',
  'tts_playback',
  'tts_playback_plan',
  'tts_playback_export',
  'document_preview',
  'document_conversion',
  'account_export',
  'tts_synthesis',
] as const;

export type ComputeAction = typeof COMPUTE_ACTIONS[number];
export type WorkerOperationAction = Exclude<ComputeAction, 'tts_synthesis'>;
export type ComputeLimitScope = 'user' | 'anonymous_device' | 'ip' | 'site';
export type ComputeLimitAudience = 'anonymous' | 'authenticated' | 'all';
export type ComputeUsageMetric = 'starts' | 'characters' | 'input_bytes' | 'files';
export type ComputePriority = 'interactive' | 'foreground' | 'background';

export const WORKER_RESOURCES = [
  'cpu_heavy',
  'model_inference',
  'whisper_alignment',
  'ffmpeg',
  'libreoffice',
  'archive_io',
] as const;

export type WorkerResource = typeof WORKER_RESOURCES[number];

const MAX_NODE_TIMER_SECONDS = 2_147_483;

export interface ComputeAdmissionWindowPolicy {
  scope: ComputeLimitScope;
  windowSeconds: number;
  limit: number;
}

export interface ComputeActiveLimitPolicy {
  scope: 'user' | 'site';
  limit: number;
  leaseSeconds: number;
}

export interface ComputeUsageLimitPolicy {
  scope: ComputeLimitScope;
  audience: ComputeLimitAudience;
  metric: Exclude<ComputeUsageMetric, 'starts'>;
  window: 'utc_day';
  limit: number;
  boundary: 'strict' | 'soft_unit';
}

export interface ComputeExecutionPolicy {
  priority: ComputePriority;
  maxQueued: number;
  maxConcurrentPerWorker: number;
  maxQueueAgeSeconds: number;
  resources: Partial<Record<WorkerResource, number>>;
}

export interface ComputeActionPolicy {
  enabled: boolean;
  admission: {
    windows: ComputeAdmissionWindowPolicy[];
    active: ComputeActiveLimitPolicy[];
  };
  usage: ComputeUsageLimitPolicy[];
  execution?: ComputeExecutionPolicy;
}

export interface ProviderLimitPolicy {
  enabled: boolean;
  maxConcurrent: number;
  requestsPerMinute: number;
  charactersPerMinute: number;
  maxWaitSeconds: number;
}

export interface ComputeLimitPolicyDocument {
  schemaVersion: 2;
  actions: Record<ComputeAction, ComputeActionPolicy>;
  worker: {
    maxExecutingPerWorker: number;
    resources: Record<WorkerResource, number>;
    policyRefreshSeconds: number;
  };
  providers: {
    defaults: ProviderLimitPolicy;
    overrides: Record<string, ProviderLimitPolicy>;
  };
}

const execution = (
  priority: ComputePriority,
  maxQueued: number,
  resources: ComputeExecutionPolicy['resources'],
): ComputeExecutionPolicy => ({
  priority,
  maxQueued,
  maxConcurrentPerWorker: 1,
  maxQueueAgeSeconds: priority === 'interactive' ? 60 : priority === 'foreground' ? 600 : 3600,
  resources,
});

const admission = (
  windows: Array<[number, number]>,
  userActive: number,
  siteActive: number,
  leaseSeconds: number,
): ComputeActionPolicy['admission'] => ({
  windows: windows.map(([limit, windowSeconds]) => ({ scope: 'user', limit, windowSeconds })),
  active: [
    { scope: 'user', limit: userActive, leaseSeconds },
    { scope: 'site', limit: siteActive, leaseSeconds },
  ],
});

const providerDefaults: ProviderLimitPolicy = {
  enabled: true,
  maxConcurrent: 3,
  requestsPerMinute: 60,
  charactersPerMinute: 100_000,
  maxWaitSeconds: 30,
};

export const DEFAULT_COMPUTE_LIMIT_POLICIES: ComputeLimitPolicyDocument = {
  schemaVersion: 2,
  actions: {
    pdf_layout: {
      enabled: false,
      admission: admission([[8, 60], [24, 600]], 1, 8, 24 * 60 * 60),
      usage: [],
      execution: execution('foreground', 50, { cpu_heavy: 1, model_inference: 1 }),
    },
    tts_playback: {
      // Playback sessions remain available for cached audio. Uncached segments
      // are limited independently by tts_synthesis.
      enabled: false,
      admission: admission([[12, 60], [60, 3600]], 2, 50, 30 * 60),
      usage: [],
      execution: execution('interactive', 100, {}),
    },
    tts_playback_plan: {
      enabled: false,
      admission: admission([[12, 60], [60, 3600]], 2, 20, 30 * 60),
      usage: [],
      execution: execution('foreground', 100, {}),
    },
    tts_playback_export: {
      enabled: false,
      admission: admission([[2, 600], [6, 86400]], 1, 4, 2 * 60 * 60),
      usage: [],
      execution: execution('foreground', 20, { ffmpeg: 1, archive_io: 1 }),
    },
    document_preview: {
      enabled: false,
      admission: admission([[30, 600], [200, 86400]], 4, 20, 30 * 60),
      usage: [],
      execution: execution('background', 200, { cpu_heavy: 1 }),
    },
    document_conversion: {
      enabled: false,
      admission: admission([[4, 600], [20, 86400]], 1, 8, 10 * 60),
      usage: [],
      execution: execution('foreground', 50, { cpu_heavy: 1, libreoffice: 1 }),
    },
    account_export: {
      enabled: false,
      admission: admission([[2, 3600], [4, 86400]], 1, 4, 2 * 60 * 60),
      usage: [],
      execution: execution('background', 20, { archive_io: 1 }),
    },
    tts_synthesis: {
      enabled: true,
      admission: { windows: [], active: [] },
      usage: [
        { scope: 'user', audience: 'anonymous', metric: 'characters', window: 'utc_day', limit: 50_000, boundary: 'soft_unit' },
        { scope: 'user', audience: 'authenticated', metric: 'characters', window: 'utc_day', limit: 500_000, boundary: 'soft_unit' },
        { scope: 'anonymous_device', audience: 'anonymous', metric: 'characters', window: 'utc_day', limit: 50_000, boundary: 'soft_unit' },
        { scope: 'ip', audience: 'anonymous', metric: 'characters', window: 'utc_day', limit: 100_000, boundary: 'soft_unit' },
        { scope: 'ip', audience: 'authenticated', metric: 'characters', window: 'utc_day', limit: 1_000_000, boundary: 'soft_unit' },
      ],
    },
  },
  worker: {
    maxExecutingPerWorker: 3,
    resources: {
      cpu_heavy: 1,
      model_inference: 1,
      whisper_alignment: 1,
      ffmpeg: 1,
      libreoffice: 1,
      archive_io: 2,
    },
    policyRefreshSeconds: 60,
  },
  providers: {
    defaults: providerDefaults,
    overrides: {},
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const hasExactKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
};

const isScope = (value: unknown): value is ComputeLimitScope =>
  value === 'user' || value === 'anonymous_device' || value === 'ip' || value === 'site';

const isPriority = (value: unknown): value is ComputePriority =>
  value === 'interactive' || value === 'foreground' || value === 'background';

const isAudience = (value: unknown): value is ComputeLimitAudience =>
  value === 'anonymous' || value === 'authenticated' || value === 'all';

function parseAdmissionWindow(value: unknown): ComputeAdmissionWindowPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['scope', 'windowSeconds', 'limit'])) return null;
  if (!isScope(value.scope) || !isPositiveInt(value.windowSeconds) || !isPositiveInt(value.limit)) return null;
  return { scope: value.scope, windowSeconds: value.windowSeconds, limit: value.limit };
}

function parseActiveLimit(value: unknown): ComputeActiveLimitPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['scope', 'limit', 'leaseSeconds'])) return null;
  if ((value.scope !== 'user' && value.scope !== 'site') || !isPositiveInt(value.limit) || !isPositiveInt(value.leaseSeconds)) return null;
  return { scope: value.scope, limit: value.limit, leaseSeconds: value.leaseSeconds };
}

function parseUsageLimit(value: unknown): ComputeUsageLimitPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['scope', 'audience', 'metric', 'window', 'limit', 'boundary'])) return null;
  if (!isScope(value.scope)
    || !isAudience(value.audience)
    || (value.metric !== 'characters' && value.metric !== 'input_bytes' && value.metric !== 'files')
    || value.window !== 'utc_day'
    || !isPositiveInt(value.limit)
    || (value.boundary !== 'strict' && value.boundary !== 'soft_unit')) return null;
  return {
    scope: value.scope,
    audience: value.audience,
    metric: value.metric,
    window: value.window,
    limit: value.limit,
    boundary: value.boundary,
  };
}

function parseExecution(value: unknown): ComputeExecutionPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'priority', 'maxQueued', 'maxConcurrentPerWorker', 'maxQueueAgeSeconds', 'resources',
  ])) return null;
  if (!isPriority(value.priority)
    || !isPositiveInt(value.maxQueued)
    || !isPositiveInt(value.maxConcurrentPerWorker)
    || !isPositiveInt(value.maxQueueAgeSeconds)
    || !isRecord(value.resources)) return null;
  const resources: Partial<Record<WorkerResource, number>> = {};
  for (const [key, units] of Object.entries(value.resources)) {
    if (!(WORKER_RESOURCES as readonly string[]).includes(key) || !isPositiveInt(units)) return null;
    resources[key as WorkerResource] = units;
  }
  return {
    priority: value.priority,
    maxQueued: value.maxQueued,
    maxConcurrentPerWorker: value.maxConcurrentPerWorker,
    maxQueueAgeSeconds: value.maxQueueAgeSeconds,
    resources,
  };
}

function parseActionPolicy(action: ComputeAction, value: unknown): ComputeActionPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, action === 'tts_synthesis'
    ? ['enabled', 'admission', 'usage']
    : ['enabled', 'admission', 'usage', 'execution'])) return null;
  if (typeof value.enabled !== 'boolean' || !isRecord(value.admission)
    || !hasExactKeys(value.admission, ['windows', 'active'])
    || !Array.isArray(value.admission.windows)
    || !Array.isArray(value.admission.active)
    || !Array.isArray(value.usage)) return null;
  const windows = value.admission.windows.map(parseAdmissionWindow);
  const active = value.admission.active.map(parseActiveLimit);
  const usage = value.usage.map(parseUsageLimit);
  if (windows.some((entry) => !entry) || active.some((entry) => !entry) || usage.some((entry) => !entry)) return null;
  if (action === 'tts_synthesis') {
    if (windows.length > 0 || active.length > 0 || usage.length === 0
      || usage.some((entry) => entry?.metric !== 'characters' || entry.boundary !== 'soft_unit')) return null;
    return {
      enabled: value.enabled,
      admission: { windows: [], active: [] },
      usage: usage as ComputeUsageLimitPolicy[],
    };
  }
  const parsedExecution = parseExecution(value.execution);
  // Version 1 has one metered sub-action: uncached TTS synthesis. Other
  // operation policies use admission and execution limits until a concrete,
  // correctly measured usage unit is wired at their owning boundary.
  if (!parsedExecution || usage.length > 0) return null;
  return {
    enabled: value.enabled,
    admission: {
      windows: windows as ComputeAdmissionWindowPolicy[],
      active: active as ComputeActiveLimitPolicy[],
    },
    usage: usage as ComputeUsageLimitPolicy[],
    execution: parsedExecution,
  };
}

function parseProviderLimit(value: unknown): ProviderLimitPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'enabled', 'maxConcurrent', 'requestsPerMinute', 'charactersPerMinute', 'maxWaitSeconds',
  ])) return null;
  if (typeof value.enabled !== 'boolean'
    || !isPositiveInt(value.maxConcurrent)
    || !isPositiveInt(value.requestsPerMinute)
    || !isPositiveInt(value.charactersPerMinute)
    || !isPositiveInt(value.maxWaitSeconds)) return null;
  return {
    enabled: value.enabled,
    maxConcurrent: value.maxConcurrent,
    requestsPerMinute: value.requestsPerMinute,
    charactersPerMinute: value.charactersPerMinute,
    maxWaitSeconds: value.maxWaitSeconds,
  };
}

export function parseComputeLimitPolicyDocument(value: unknown): ComputeLimitPolicyDocument | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'actions', 'worker', 'providers'])
    || value.schemaVersion !== 2 || !isRecord(value.actions)
    || !hasExactKeys(value.actions, COMPUTE_ACTIONS) || !isRecord(value.worker)
    || !hasExactKeys(value.worker, ['maxExecutingPerWorker', 'resources', 'policyRefreshSeconds'])
    || !isPositiveInt(value.worker.maxExecutingPerWorker)
    || !isPositiveInt(value.worker.policyRefreshSeconds)
    || value.worker.policyRefreshSeconds > MAX_NODE_TIMER_SECONDS
    || !isRecord(value.worker.resources)
    || !hasExactKeys(value.worker.resources, WORKER_RESOURCES)
    || !isRecord(value.providers)
    || !hasExactKeys(value.providers, ['defaults', 'overrides'])
    || !isRecord(value.providers.overrides)) return undefined;

  const resources = {} as Record<WorkerResource, number>;
  for (const resource of WORKER_RESOURCES) {
    const units = value.worker.resources[resource];
    if (!isPositiveInt(units)) return undefined;
    resources[resource] = units;
  }

  const actions = {} as Record<ComputeAction, ComputeActionPolicy>;
  for (const action of COMPUTE_ACTIONS) {
    const parsed = parseActionPolicy(action, value.actions[action]);
    if (!parsed) return undefined;
    if (parsed.execution) {
      if (parsed.execution.maxConcurrentPerWorker > value.worker.maxExecutingPerWorker) return undefined;
      for (const [resource, units] of Object.entries(parsed.execution.resources)) {
        if (units > resources[resource as WorkerResource]) return undefined;
      }
    }
    actions[action] = parsed;
  }

  const defaults = parseProviderLimit(value.providers.defaults);
  if (!defaults) return undefined;
  const overrides: Record<string, ProviderLimitPolicy> = {};
  for (const [providerRef, raw] of Object.entries(value.providers.overrides)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerRef)) return undefined;
    const parsed = parseProviderLimit(raw);
    if (!parsed) return undefined;
    overrides[providerRef] = parsed;
  }

  return {
    schemaVersion: 2,
    actions,
    worker: {
      maxExecutingPerWorker: value.worker.maxExecutingPerWorker,
      resources,
      policyRefreshSeconds: value.worker.policyRefreshSeconds,
    },
    providers: { defaults, overrides },
  };
}

export function cloneComputeLimitPolicyDocument(
  value: ComputeLimitPolicyDocument = DEFAULT_COMPUTE_LIMIT_POLICIES,
): ComputeLimitPolicyDocument {
  return JSON.parse(JSON.stringify(value)) as ComputeLimitPolicyDocument;
}
