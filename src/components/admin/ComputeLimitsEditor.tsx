'use client';

import {
  COMPUTE_ACTIONS,
  WORKER_RESOURCES,
  cloneComputeLimitPolicyDocument,
  parseComputeLimitPolicyDocument,
  type ComputeAction,
  type ComputeLimitPolicyDocument,
  type ComputePriority,
  type ProviderLimitPolicy,
  type WorkerResource,
} from '@openreader/runtime-config/compute-limits';
import { Button, Input, Select, ToggleRow } from '@/components/ui';

const ACTION_DETAILS: Record<ComputeAction, { label: string; description: string }> = {
  pdf_layout: {
    label: 'PDF layout analysis',
    description: 'Model-backed page parsing requested while a PDF is prepared.',
  },
  tts_playback: {
    label: 'Live playback sessions',
    description: 'Session starts only. Leave this off if cached playback must always remain available.',
  },
  tts_playback_plan: {
    label: 'Playback plan creation',
    description: 'Builds the reusable text and segment plan behind playback.',
  },
  tts_playback_export: {
    label: 'Audiobook assembly',
    description: 'Long-running audio generation and archive assembly.',
  },
  document_preview: {
    label: 'Document previews',
    description: 'Background cover and preview extraction.',
  },
  document_conversion: {
    label: 'Document conversion',
    description: 'DOCX and other source conversion work.',
  },
  account_export: {
    label: 'Account export',
    description: 'Background collection and archive creation for account data.',
  },
  tts_synthesis: {
    label: 'New TTS generation',
    description: 'Counts only uncached segments immediately before a provider call.',
  },
};

const RESOURCE_LABELS: Record<WorkerResource, string> = {
  cpu_heavy: 'CPU-heavy work',
  model_inference: 'Model inference',
  whisper_alignment: 'Whisper alignment',
  ffmpeg: 'FFmpeg',
  libreoffice: 'LibreOffice',
  archive_io: 'Archive I/O',
};

const PRIORITIES: ComputePriority[] = ['interactive', 'foreground', 'background'];

function positiveInteger(raw: string, minimum = 1): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : minimum;
}

function formatScope(scope: string): string {
  if (scope === 'anonymous_device') return 'anonymous device';
  return scope;
}

function usageLabel(scope: string, audience: string): string {
  if (scope === 'user') return `${audience} user`;
  return `${audience} ${formatScope(scope)}`;
}

function LimitNumber({
  label,
  value,
  onChange,
  minimum = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  minimum?: number;
  suffix?: string;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[11px] font-medium text-soft">{label}</span>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={minimum}
          step={1}
          value={value}
          onChange={(event) => onChange(positiveInteger(event.target.value, minimum))}
          className="h-8 min-w-0 text-xs"
        />
        {suffix ? <span className="shrink-0 text-[11px] text-muted">{suffix}</span> : null}
      </div>
    </label>
  );
}

function ProviderLimits({
  title,
  description,
  value,
  onChange,
  onRemove,
}: {
  title: string;
  description: string;
  value: ProviderLimitPolicy;
  onChange: (mutate: (draft: ProviderLimitPolicy) => void) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="rounded-lg border border-line-soft bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        </div>
        {onRemove ? (
          <Button variant="ghost" size="xs" onClick={onRemove}>Remove</Button>
        ) : null}
      </div>
      <ToggleRow
        label="Enforce provider capacity"
        description="Wait for shared provider capacity before starting an uncached segment."
        checked={value.enabled}
        onChange={(enabled) => onChange((draft) => { draft.enabled = enabled; })}
        variant="flat"
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <LimitNumber
          label="Concurrent calls"
          value={value.maxConcurrent}
          onChange={(next) => onChange((draft) => { draft.maxConcurrent = next; })}
        />
        <LimitNumber
          label="Requests"
          suffix="/ min"
          value={value.requestsPerMinute}
          onChange={(next) => onChange((draft) => { draft.requestsPerMinute = next; })}
        />
        <LimitNumber
          label="Characters"
          suffix="/ min"
          value={value.charactersPerMinute}
          onChange={(next) => onChange((draft) => { draft.charactersPerMinute = next; })}
        />
        <LimitNumber
          label="Maximum wait"
          suffix="sec"
          value={value.maxWaitSeconds}
          onChange={(next) => onChange((draft) => { draft.maxWaitSeconds = next; })}
        />
      </div>
    </div>
  );
}

export function ComputeLimitsEditor({
  policy,
  providers,
  onChange,
}: {
  policy: ComputeLimitPolicyDocument;
  providers: Array<{ slug: string; displayName: string }>;
  onChange: (policy: ComputeLimitPolicyDocument) => void;
}) {
  const update = (mutate: (draft: ComputeLimitPolicyDocument) => void) => {
    const next = cloneComputeLimitPolicyDocument(policy);
    mutate(next);
    const parsed = parseComputeLimitPolicyDocument(next);
    if (parsed) onChange(parsed);
  };

  const updateProvider = (
    providerRef: string | null,
    mutate: (draft: ProviderLimitPolicy) => void,
  ) => update((draft) => {
    mutate(providerRef === null
      ? draft.providers.defaults
      : draft.providers.overrides[providerRef]);
  });

  const addableProviders = providers.filter(({ slug }) => !(slug in policy.providers.overrides));
  const maxActionConcurrency = Math.max(...COMPUTE_ACTIONS.map((action) => (
    policy.actions[action].execution?.maxConcurrentPerWorker ?? 1
  )));
  const minimumResourceCapacity = (resource: WorkerResource) => Math.max(
    1,
    ...COMPUTE_ACTIONS.map((action) => policy.actions[action].execution?.resources[resource] ?? 0),
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-surface-sunken p-3">
        <p className="text-sm font-medium text-foreground">Usage and request limits</p>
        <p className="mt-0.5 text-xs text-muted">
          Request-limit switches control admission only; the TTS switch controls generated-character usage.
          Worker queues, resource capacity, and provider capacity continue to apply either way.
        </p>
      </div>

      <div className="space-y-2">
        {COMPUTE_ACTIONS.map((action) => {
          const actionPolicy = policy.actions[action];
          const detail = ACTION_DETAILS[action];
          return (
            <details key={action} className="group rounded-lg border border-line-soft bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:content-none">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{detail.label}</p>
                  <p className="truncate text-xs text-muted">{detail.description}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                  actionPolicy.enabled
                    ? 'bg-accent-wash text-accent'
                    : 'bg-surface-sunken text-muted'
                }`}>
                  {action === 'tts_synthesis'
                    ? (actionPolicy.enabled ? 'Usage limited' : 'Usage unlimited')
                    : (actionPolicy.enabled ? 'Admission limited' : 'Admission open')}
                </span>
              </summary>
              <div className="space-y-3 border-t border-line-soft px-3 pb-3 pt-2">
                <ToggleRow
                  label={action === 'tts_synthesis' ? 'Limit new generation' : 'Enforce request limits'}
                  description={action === 'tts_synthesis'
                    ? 'The segment that crosses a daily threshold finishes; the next uncached segment stops.'
                    : 'Reject new work after any start-window or active-work limit is reached.'}
                  checked={actionPolicy.enabled}
                  onChange={(enabled) => update((draft) => { draft.actions[action].enabled = enabled; })}
                  variant="flat"
                />

                {action === 'tts_synthesis' ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {actionPolicy.usage.map((limit, index) => (
                      <LimitNumber
                        key={`${limit.scope}:${limit.audience}`}
                        label={`${usageLabel(limit.scope, limit.audience)} daily characters`}
                        value={limit.limit}
                        onChange={(next) => update((draft) => {
                          draft.actions.tts_synthesis.usage[index].limit = next;
                        })}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Start windows</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {actionPolicy.admission.windows.map((window, index) => (
                          <div key={`${window.scope}:${index}`} className="grid grid-cols-2 gap-2 rounded-md bg-surface-sunken p-2">
                            <LimitNumber
                              label={`${formatScope(window.scope)} starts`}
                              value={window.limit}
                              onChange={(next) => update((draft) => {
                                draft.actions[action].admission.windows[index].limit = next;
                              })}
                            />
                            <LimitNumber
                              label="Window"
                              suffix="sec"
                              value={window.windowSeconds}
                              onChange={(next) => update((draft) => {
                                draft.actions[action].admission.windows[index].windowSeconds = next;
                              })}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Active work</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {actionPolicy.admission.active.map((active, index) => (
                          <div key={active.scope} className="grid grid-cols-2 gap-2 rounded-md bg-surface-sunken p-2">
                            <LimitNumber
                              label={`${formatScope(active.scope)} concurrent`}
                              value={active.limit}
                              onChange={(next) => update((draft) => {
                                draft.actions[action].admission.active[index].limit = next;
                              })}
                            />
                            <LimitNumber
                              label="Lease timeout"
                              suffix="sec"
                              value={active.leaseSeconds}
                              onChange={(next) => update((draft) => {
                                draft.actions[action].admission.active[index].leaseSeconds = next;
                              })}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    {actionPolicy.execution ? (
                      <div>
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Worker queue</p>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <LimitNumber
                            label="Queued jobs"
                            value={actionPolicy.execution.maxQueued}
                            onChange={(next) => update((draft) => {
                              draft.actions[action].execution!.maxQueued = next;
                            })}
                          />
                          <LimitNumber
                            label="Concurrent / worker"
                            value={actionPolicy.execution.maxConcurrentPerWorker}
                            onChange={(next) => update((draft) => {
                              draft.actions[action].execution!.maxConcurrentPerWorker = Math.min(
                                next,
                                draft.worker.maxExecutingPerWorker,
                              );
                            })}
                          />
                          <LimitNumber
                            label="Maximum queue age"
                            suffix="sec"
                            value={actionPolicy.execution.maxQueueAgeSeconds}
                            onChange={(next) => update((draft) => {
                              draft.actions[action].execution!.maxQueueAgeSeconds = next;
                            })}
                          />
                          <div className="space-y-1">
                            <span className="block text-[11px] font-medium text-soft">Priority</span>
                            <Select
                              value={actionPolicy.execution.priority}
                              options={PRIORITIES}
                              onChange={(priority) => update((draft) => {
                                draft.actions[action].execution!.priority = priority;
                              })}
                              buttonClassName="h-8 bg-background py-1 text-xs capitalize"
                              renderValue={(priority) => priority}
                              renderOption={(priority) => <span className="capitalize">{priority}</span>}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </details>
          );
        })}
      </div>

      <details className="group rounded-lg border border-line-soft bg-background">
        <summary className="cursor-pointer list-none px-3 py-2.5 marker:content-none">
          <p className="text-sm font-medium text-foreground">Worker capacity</p>
          <p className="text-xs text-muted">Always-enforced local queues and named resource pools.</p>
        </summary>
        <div className="space-y-3 border-t border-line-soft p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <LimitNumber
              label="Executing per worker"
              value={policy.worker.maxExecutingPerWorker}
              minimum={maxActionConcurrency}
              onChange={(next) => update((draft) => { draft.worker.maxExecutingPerWorker = next; })}
            />
            <LimitNumber
              label="Policy refresh"
              suffix="sec"
              value={policy.worker.policyRefreshSeconds}
              onChange={(next) => update((draft) => { draft.worker.policyRefreshSeconds = next; })}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Resource slots per worker</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {WORKER_RESOURCES.map((resource) => (
                <LimitNumber
                  key={resource}
                  label={RESOURCE_LABELS[resource]}
                  value={policy.worker.resources[resource]}
                  minimum={minimumResourceCapacity(resource)}
                  onChange={(next) => update((draft) => { draft.worker.resources[resource] = next; })}
                />
              ))}
            </div>
          </div>
        </div>
      </details>

      <details className="group rounded-lg border border-line-soft bg-background">
        <summary className="cursor-pointer list-none px-3 py-2.5 marker:content-none">
          <p className="text-sm font-medium text-foreground">TTS provider capacity</p>
          <p className="text-xs text-muted">Shared concurrency and rolling one-minute throughput.</p>
        </summary>
        <div className="space-y-2 border-t border-line-soft p-3">
          <ProviderLimits
            title="All providers"
            description="Used whenever a provider does not have its own override."
            value={policy.providers.defaults}
            onChange={(mutate) => updateProvider(null, mutate)}
          />
          {Object.entries(policy.providers.overrides).map(([providerRef, limits]) => {
            const displayName = providers.find(({ slug }) => slug === providerRef)?.displayName ?? providerRef;
            return (
              <ProviderLimits
                key={providerRef}
                title={displayName}
                description={`Override for ${providerRef}`}
                value={limits}
                onChange={(mutate) => updateProvider(providerRef, mutate)}
                onRemove={() => update((draft) => { delete draft.providers.overrides[providerRef]; })}
              />
            );
          })}
          {addableProviders.length > 0 ? (
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-soft">Add a provider override</span>
              <Select
                value={undefined}
                options={addableProviders}
                getOptionKey={(provider) => provider.slug}
                placeholder="Choose provider…"
                renderValue={(provider) => `${provider.displayName} (${provider.slug})`}
                renderOption={(provider) => `${provider.displayName} (${provider.slug})`}
                onChange={({ slug: providerRef }) => {
                  update((draft) => {
                    draft.providers.overrides[providerRef] = {
                      ...draft.providers.defaults,
                      enabled: true,
                    };
                  });
                }}
                buttonClassName="h-9 bg-background py-1 text-xs"
              />
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
