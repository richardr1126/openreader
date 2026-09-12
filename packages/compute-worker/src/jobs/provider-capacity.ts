import { createHash, randomUUID } from 'node:crypto';
import type {
  ComputeLimitPolicyDocument,
  ProviderLimitPolicy,
} from '@openreader/runtime-config/compute-limits';
import { createJsonCodec } from '../infrastructure/json-codec';
import {
  isKvCasConflictError,
  type KvStoreLike,
} from '../infrastructure/nats-adapters';

type ProviderState = {
  active: number;
  requests: number[];
  characters: Array<{ at: number; units: number }>;
};

type DistributedProviderState = {
  schemaVersion: 1;
  holders: Record<string, number>;
  requests: number[];
  characters: Array<{ at: number; units: number }>;
  cooldownUntil: number;
};

const PROVIDER_LEASE_MS = 5 * 60 * 1000;
const EMPTY_DISTRIBUTED_STATE: DistributedProviderState = {
  schemaVersion: 1,
  holders: {},
  requests: [],
  characters: [],
  cooldownUntil: 0,
};
const distributedCodec = createJsonCodec<DistributedProviderState>();

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timeout);
    reject(signal?.reason);
  };
  const timeout = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

function providerCapacityKey(providerRef: string): string {
  const hash = createHash('sha256').update(providerRef).digest('hex');
  return `provider_capacity.${hash}`;
}

function compactState(state: DistributedProviderState, now: number): DistributedProviderState {
  const cutoff = now - 60_000;
  return {
    schemaVersion: 1,
    holders: Object.fromEntries(Object.entries(state.holders).filter(([, expiresAt]) => expiresAt > now)),
    requests: state.requests.filter((at) => at > cutoff),
    characters: state.characters.filter((entry) => entry.at > cutoff),
    cooldownUntil: Math.max(0, Number(state.cooldownUntil) || 0),
  };
}

function hasCapacity(
  state: DistributedProviderState,
  limits: ProviderLimitPolicy,
  characters: number,
  now: number,
): boolean {
  const characterTotal = state.characters.reduce((sum, entry) => sum + entry.units, 0);
  return state.cooldownUntil <= now
    && Object.keys(state.holders).length < limits.maxConcurrent
    && state.requests.length < limits.requestsPerMinute
    && characterTotal + characters <= limits.charactersPerMinute;
}

export class ProviderCapacityCoordinator {
  private readonly states = new Map<string, ProviderState>();

  constructor(
    private readonly getPolicy: () => ComputeLimitPolicyDocument,
    private readonly getKv?: () => Promise<KvStoreLike>,
    private readonly logger?: { error(data: unknown, message?: string): void },
  ) {}

  private limits(providerRef: string): ProviderLimitPolicy {
    const providers = this.getPolicy().providers;
    return providers.overrides[providerRef] ?? providers.defaults;
  }

  configuredMaxConcurrent(providerRef: string): number | null {
    const limits = this.limits(providerRef);
    return limits.enabled ? limits.maxConcurrent : null;
  }

  private async acquireDistributed(input: {
    providerRef: string;
    characters: number;
    signal?: AbortSignal;
  }): Promise<() => Promise<void>> {
    const key = providerCapacityKey(input.providerRef);
    const holderId = randomUUID();
    const startedAt = Date.now();
    while (true) {
      if (input.signal?.aborted) throw input.signal.reason;
      const now = Date.now();
      const limits = this.limits(input.providerRef);
      if (!limits.enabled) return async () => undefined;
      const kv = await this.getKv!();
      const entry = await kv.get(key);
      const current = compactState(
        entry?.operation === 'PUT' ? distributedCodec.decode(entry.value) : EMPTY_DISTRIBUTED_STATE,
        now,
      );
      if (hasCapacity(current, limits, input.characters, now)) {
        const next: DistributedProviderState = {
          ...current,
          holders: { ...current.holders, [holderId]: now + PROVIDER_LEASE_MS },
          requests: [...current.requests, now],
          characters: [...current.characters, { at: now, units: input.characters }],
        };
        try {
          if (entry?.operation === 'PUT') await kv.update(key, distributedCodec.encode(next), entry.revision);
          else await kv.create(key, distributedCodec.encode(next));
          let released = false;
          let releasePromise: Promise<void> | null = null;
          return async () => {
            if (released) return;
            if (releasePromise) return releasePromise;
            releasePromise = this.releaseDistributed(key, holderId);
            try {
              await releasePromise;
              released = true;
            } catch (error) {
              this.logger?.error({ error: String(error), providerKey: key }, 'provider capacity release failed');
              releasePromise = null;
              throw error;
            }
          };
        } catch (error) {
          if (!isKvCasConflictError(error)) throw error;
          continue;
        }
      }
      if (now - startedAt >= limits.maxWaitSeconds * 1000) {
        throw new Error('TTS provider capacity wait timed out');
      }
      await sleep(50, input.signal);
    }
  }

  private async releaseDistributed(key: string, holderId: string): Promise<void> {
    if (!this.getKv) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const kv = await this.getKv();
      const entry = await kv.get(key);
      if (entry?.operation !== 'PUT') return;
      const current = distributedCodec.decode(entry.value);
      if (!(holderId in current.holders)) return;
      const holders = { ...current.holders };
      delete holders[holderId];
      try {
        await kv.update(key, distributedCodec.encode({ ...current, holders }), entry.revision);
        return;
      } catch (error) {
        if (!isKvCasConflictError(error)) throw error;
        await sleep(Math.min(10 * (attempt + 1), 50));
      }
    }
    throw new Error('Provider capacity release exhausted CAS retries');
  }

  async coolDown(providerRef: string, retryAfterSeconds: number): Promise<void> {
    if (!this.getKv) return;
    const key = providerCapacityKey(providerRef);
    const cooldownUntil = Date.now() + Math.max(1, Math.floor(retryAfterSeconds)) * 1000;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const kv = await this.getKv();
      const entry = await kv.get(key);
      const current = entry?.operation === 'PUT'
        ? distributedCodec.decode(entry.value)
        : EMPTY_DISTRIBUTED_STATE;
      const next = { ...current, cooldownUntil: Math.max(current.cooldownUntil, cooldownUntil) };
      try {
        if (entry?.operation === 'PUT') await kv.update(key, distributedCodec.encode(next), entry.revision);
        else await kv.create(key, distributedCodec.encode(next));
        return;
      } catch (error) {
        if (!isKvCasConflictError(error)) throw error;
      }
    }
  }

  async acquire(input: {
    providerRef: string;
    characters: number;
    signal?: AbortSignal;
  }): Promise<() => Promise<void>> {
    if (this.getKv) return this.acquireDistributed(input);
    const state = this.states.get(input.providerRef) ?? { active: 0, requests: [], characters: [] };
    this.states.set(input.providerRef, state);
    const startedAt = Date.now();
    while (true) {
      if (input.signal?.aborted) throw input.signal.reason;
      const now = Date.now();
      const limits = this.limits(input.providerRef);
      if (!limits.enabled) return async () => undefined;
      const cutoff = now - 60_000;
      state.requests = state.requests.filter((at) => at > cutoff);
      state.characters = state.characters.filter((entry) => entry.at > cutoff);
      const characters = state.characters.reduce((sum, entry) => sum + entry.units, 0);
      const available = state.active < limits.maxConcurrent
        && state.requests.length < limits.requestsPerMinute
        && characters + input.characters <= limits.charactersPerMinute;
      if (available) {
        state.active += 1;
        state.requests.push(now);
        state.characters.push({ at: now, units: input.characters });
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          state.active = Math.max(0, state.active - 1);
        };
      }
      if (now - startedAt >= limits.maxWaitSeconds * 1000) {
        throw new Error('TTS provider capacity wait timed out');
      }
      await sleep(50, input.signal);
    }
  }
}
