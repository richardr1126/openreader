import { LRUCache } from 'lru-cache';
import { serverLogger } from '@/lib/server/logger';
import { logServerError } from '@/lib/server/errors/logging';
import {
  resolveProviderModels,
  type ReplicateVoiceInputKey,
  type ResolveVoicesOptions,
} from '@/lib/shared/tts-provider-catalog';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseReplicateModelIdentifier(model: string): {
  owner: string;
  name: string;
  version?: string;
} | null {
  const [ref, version] = model.split(':', 2);
  const segments = ref.split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return null;
  }

  const parsed = {
    owner: segments[0],
    name: segments[1],
  };

  return version
    ? { ...parsed, version }
    : parsed;
}

function extractSchemaStringEnums(schemaNode: unknown, seen = new Set<object>()): string[] {
  if (!isRecord(schemaNode)) {
    return [];
  }
  if (seen.has(schemaNode)) {
    return [];
  }
  seen.add(schemaNode);

  const values: string[] = [];
  if (Array.isArray(schemaNode.enum)) {
    values.push(...schemaNode.enum.filter((value): value is string => typeof value === 'string'));
  }
  if (typeof schemaNode.const === 'string') {
    values.push(schemaNode.const);
  }

  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const branch = schemaNode[key];
    if (!Array.isArray(branch)) continue;
    for (const item of branch) {
      values.push(...extractSchemaStringEnums(item, seen));
    }
  }

  if (schemaNode.items) {
    values.push(...extractSchemaStringEnums(schemaNode.items, seen));
  }

  return values;
}

function walkRecordGraph(root: unknown, visit: (node: Record<string, unknown>) => boolean | void): void {
  if (!isRecord(root)) {
    return;
  }

  const stack: Record<string, unknown>[] = [root];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (visit(current)) {
      return;
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isRecord(item)) {
            stack.push(item);
          }
        }
      } else if (isRecord(value)) {
        stack.push(value);
      }
    }
  }
}

const REPLICATE_VOICE_KEYS = ['voice', 'voice_id', 'speaker'] as const satisfies readonly ReplicateVoiceInputKey[];
const REPLICATE_LANGUAGE_KEYS = [
  'language',
  'lang',
  'language_code',
  'locale',
  'language_id',
  'language_boost',
] as const;
export type ReplicateLanguageInputKey = typeof REPLICATE_LANGUAGE_KEYS[number];
export type ReplicateLanguageInput = {
  key: ReplicateLanguageInputKey;
  allowedValues: string[];
};
const REPLICATE_BUILT_IN_MODELS = new Set(
  resolveProviderModels('replicate')
    .map((model) => model.id)
    .filter((id) => id !== 'custom')
);

function extractReplicateVoicesFromOpenApiSchema(openApiSchema: unknown): string[] {
  const voices: string[] = [];

  walkRecordGraph(openApiSchema, (node) => {
    const properties = node.properties;
    if (!isRecord(properties)) {
      return;
    }
    for (const key of REPLICATE_VOICE_KEYS) {
      if (!(key in properties)) continue;
      voices.push(...extractSchemaStringEnums(properties[key]));
    }
  });

  return Array.from(
    new Set(
      voices
        .map((voice) => voice.trim())
        .filter((voice) => voice.length > 0)
    )
  );
}

function extractReplicateVoiceInputKeyFromOpenApiSchema(openApiSchema: unknown): ReplicateVoiceInputKey | null {
  let found: ReplicateVoiceInputKey | null = null;

  walkRecordGraph(openApiSchema, (node) => {
    const properties = node.properties;
    if (!isRecord(properties)) {
      return;
    }
    for (const key of REPLICATE_VOICE_KEYS) {
      if (key in properties) {
        found = key;
        return true;
      }
    }
  });

  return found;
}

function extractReplicateLanguageInputFromOpenApiSchema(openApiSchema: unknown): ReplicateLanguageInput | null {
  let found: ReplicateLanguageInput | null = null;

  walkRecordGraph(openApiSchema, (node) => {
    const properties = node.properties;
    if (!isRecord(properties)) return;
    for (const key of REPLICATE_LANGUAGE_KEYS) {
      if (key in properties) {
        found = {
          key,
          allowedValues: extractSchemaStringEnums(properties[key]),
        };
        return true;
      }
    }
  });

  return found;
}

async function fetchReplicateOpenApiSchema(apiKey: string, model: string): Promise<unknown | null> {
  const parsedModel = parseReplicateModelIdentifier(model);
  if (!parsedModel) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const endpoint = parsedModel.version
      ? `https://api.replicate.com/v1/models/${parsedModel.owner}/${parsedModel.name}/versions/${parsedModel.version}`
      : `https://api.replicate.com/v1/models/${parsedModel.owner}/${parsedModel.name}`;

    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    let openApiSchema: unknown = null;

    if (parsedModel.version) {
      if (isRecord(data)) {
        openApiSchema = data.openapi_schema;
      }
    } else if (isRecord(data) && isRecord(data.latest_version)) {
      openApiSchema = data.latest_version.openapi_schema;
    }

    return openApiSchema;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    logServerError(serverLogger, {
      event: 'tts.voice_resolution.replicate_schema_fetch.failed',
      msg: 'Failed fetching Replicate model schema',
      error,
      normalize: { code: 'TTS_VOICE_RESOLUTION_REPLICATE_SCHEMA_FETCH_FAILED', errorClass: 'upstream' },
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const REPLICATE_VOICE_INPUT_KEY_CACHE_MAX_ENTRIES = 128;
const REPLICATE_LANGUAGE_INPUT_KEY_CACHE_MAX_ENTRIES = 128;
const REPLICATE_OPENAPI_SCHEMA_PROMISE_CACHE_MAX_ENTRIES = 128;

const replicateVoiceInputKeyCache = new LRUCache<string, ReplicateVoiceInputKey>({
  max: REPLICATE_VOICE_INPUT_KEY_CACHE_MAX_ENTRIES,
});
const replicateLanguageInputCache = new LRUCache<string, ReplicateLanguageInput>({
  max: REPLICATE_LANGUAGE_INPUT_KEY_CACHE_MAX_ENTRIES,
});
const replicateOpenApiSchemaPromiseCache = new LRUCache<string, Promise<unknown | null>>({
  max: REPLICATE_OPENAPI_SCHEMA_PROMISE_CACHE_MAX_ENTRIES,
});

async function getReplicateOpenApiSchemaCached(apiKey: string, model: string): Promise<unknown | null> {
  const cachedPromise = replicateOpenApiSchemaPromiseCache.get(model);
  if (cachedPromise) {
    return cachedPromise;
  }

  const fetchPromise = fetchReplicateOpenApiSchema(apiKey, model);
  replicateOpenApiSchemaPromiseCache.set(model, fetchPromise);

  const schema = await fetchPromise;
  if (schema === null) {
    replicateOpenApiSchemaPromiseCache.delete(model);
  }
  return schema;
}

async function fetchReplicateVoices(apiKey: string, model: string): Promise<string[] | null> {
  const openApiSchema = await getReplicateOpenApiSchemaCached(apiKey, model);
  const apiVoices = extractReplicateVoicesFromOpenApiSchema(openApiSchema);
  return apiVoices.length > 0 ? apiVoices : null;
}

export async function resolveReplicateVoiceInputKey({
  provider,
  model,
  apiKey = '',
}: ResolveVoicesOptions): Promise<ReplicateVoiceInputKey | null> {
  if (provider !== 'replicate' || REPLICATE_BUILT_IN_MODELS.has(model) || !apiKey) {
    return null;
  }

  const cached = replicateVoiceInputKeyCache.get(model);
  if (cached) {
    return cached;
  }

  const openApiSchema = await getReplicateOpenApiSchemaCached(apiKey, model);
  const inputKey = extractReplicateVoiceInputKeyFromOpenApiSchema(openApiSchema);
  if (inputKey) {
    replicateVoiceInputKeyCache.set(model, inputKey);
  }
  return inputKey;
}

export async function resolveReplicateLanguageInputKey({
  provider,
  model,
  apiKey = '',
}: ResolveVoicesOptions): Promise<ReplicateLanguageInputKey | null> {
  const input = await resolveReplicateLanguageInput({ provider, model, apiKey });
  return input?.key ?? null;
}

export async function resolveReplicateLanguageInput({
  provider,
  model,
  apiKey = '',
}: ResolveVoicesOptions): Promise<ReplicateLanguageInput | null> {
  if (provider !== 'replicate' || !apiKey) return null;

  const cached = replicateLanguageInputCache.get(model);
  if (cached) return cached;

  const openApiSchema = await getReplicateOpenApiSchemaCached(apiKey, model);
  const input = extractReplicateLanguageInputFromOpenApiSchema(openApiSchema);
  if (input) {
    replicateLanguageInputCache.set(model, input);
  }
  return input;
}

async function fetchDeepinfraVoices(apiKey: string): Promise<string[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch('https://api.deepinfra.com/v1/voices', {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch Deepinfra voices');
    }

    const data = await response.json();
    if (data.voices && Array.isArray(data.voices)) {
      return data.voices
        .filter((voice: { user_id?: string }) => voice.user_id !== 'preset')
        .map((voice: { name: string }) => voice.name);
    }
    return [];
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return [];
    }
    logServerError(serverLogger, {
      event: 'tts.voice_resolution.deepinfra_voices_fetch.failed',
      msg: 'Failed fetching Deepinfra voices',
      error,
      normalize: { code: 'TTS_VOICE_RESOLUTION_DEEPINFRA_FETCH_FAILED', errorClass: 'upstream' },
    });
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCustomOpenAiVoices(baseUrl: string, apiKey: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${normalizedBaseUrl}/audio/voices`, {
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return Array.isArray(data.voices) && data.voices.every((voice: unknown) => typeof voice === 'string')
      ? data.voices
      : null;
  } catch {
    serverLogger.info({
      event: 'tts.voice_resolution.custom_endpoint.voices_unsupported',
      degraded: true,
      fallbackPath: 'provider_default_voices',
    }, 'Custom endpoint does not support voices, using defaults');
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveVoices({ provider, model, apiKey = '', baseUrl = '' }: ResolveVoicesOptions): Promise<string[]> {
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: provider,
    providerType: provider,
    model,
  });
  const defaultVoices = providerModelPolicy.defaultVoices;
  const voiceSource = providerModelPolicy.voiceSource;

  if (voiceSource === 'deepinfra-api') {
    const apiVoices = await fetchDeepinfraVoices(apiKey);
    if (apiVoices.length > 0) {
      return [...defaultVoices, ...apiVoices];
    }
    return defaultVoices;
  }

  if (voiceSource === 'custom-openai-api') {
    if (!baseUrl) {
      return defaultVoices;
    }
    const apiVoices = await fetchCustomOpenAiVoices(baseUrl, apiKey);
    if (apiVoices !== null) {
      return apiVoices;
    }
  }

  if (voiceSource === 'replicate-api') {
    if (!apiKey) {
      return defaultVoices;
    }
    const apiVoices = await fetchReplicateVoices(apiKey, model);
    if (apiVoices !== null) {
      return apiVoices;
    }
  }

  return defaultVoices;
}
