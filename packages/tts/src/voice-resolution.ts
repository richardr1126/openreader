import { LRUCache } from 'lru-cache';
import { fetchOpenRouterModels } from './openrouter';
import { logTtsError, ttsLogger } from './logger';
import {
  OPENAI_DEFAULT_VOICES,
  isRetiredReplicateModel,
  replicateExecutionModel,
  resolveProviderModels,
  type ReplicateVoiceInputKey,
  type ResolveVoicesOptions,
} from './provider-catalog';
import { resolveTtsProviderModelPolicy } from './provider-policy';

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

// Cog-built Replicate models declare enum inputs as
// `allOf: [{ $ref: '#/components/schemas/<name>' }]`, so local refs must be
// followed to find the allowed values.
function resolveLocalSchemaRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(node)) return undefined;
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function extractSchemaStringEnums(schemaNode: unknown, root: unknown, seen = new Set<object>()): string[] {
  if (!isRecord(schemaNode)) {
    return [];
  }
  if (seen.has(schemaNode)) {
    return [];
  }
  seen.add(schemaNode);

  const values: string[] = [];
  if (typeof schemaNode.$ref === 'string') {
    values.push(...extractSchemaStringEnums(resolveLocalSchemaRef(root, schemaNode.$ref), root, seen));
  }
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
      values.push(...extractSchemaStringEnums(item, root, seen));
    }
  }

  if (schemaNode.items) {
    values.push(...extractSchemaStringEnums(schemaNode.items, root, seen));
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
      voices.push(...extractSchemaStringEnums(properties[key], openApiSchema));
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
          allowedValues: extractSchemaStringEnums(properties[key], openApiSchema),
        };
        return true;
      }
    }
  });

  return found;
}

async function fetchReplicateOpenApiSchema(apiKey: string, model: string): Promise<unknown | null> {
  if (isRetiredReplicateModel(model)) return null;
  const parsedModel = parseReplicateModelIdentifier(replicateExecutionModel(model));
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
    logTtsError(ttsLogger, {
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

// Custom OpenAI-compatible servers expose voices under different, non-standardized
// routes. Probe the common ones in order until one returns a usable list.
const CUSTOM_OPENAI_VOICE_ENDPOINTS = ['/audio/voices', '/voices', '/styles'] as const;

// Extract a list of voice/style names from an arbitrary JSON payload. Handles a
// bare string array, the OpenAI-style `{ voices: [...] }`, the `{ styles: [...] }`
// shape used by some servers, and arrays of objects keyed by name/id/voice/style.
function extractVoiceNames(payload: unknown): string[] | null {
  const collect = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) {
      return null;
    }
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        names.push(item);
      } else if (isRecord(item)) {
        const name = item.name ?? item.id ?? item.voice ?? item.style;
        if (typeof name === 'string') {
          names.push(name);
        }
      }
    }
    // An explicitly empty list is a valid answer ("this server has no voices");
    // honor it rather than probing further or falling back to defaults.
    if (value.length === 0) {
      return [];
    }
    const cleaned = Array.from(
      new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
    );
    // The value was an array but yielded no usable names (unrecognized shape);
    // treat as not-a-voices-list so the next endpoint / defaults can apply.
    return cleaned.length > 0 ? cleaned : null;
  };

  if (Array.isArray(payload)) {
    return collect(payload);
  }
  if (isRecord(payload)) {
    return collect(payload.voices) ?? collect(payload.styles) ?? collect(payload.data);
  }
  return null;
}

async function fetchCustomOpenAiVoicesFromEndpoint(
  url: string,
  apiKey: string,
): Promise<string[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    return extractVoiceNames(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCustomOpenAiVoices(baseUrl: string, apiKey: string): Promise<string[] | null> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  for (const endpoint of CUSTOM_OPENAI_VOICE_ENDPOINTS) {
    const voices = await fetchCustomOpenAiVoicesFromEndpoint(`${normalizedBaseUrl}${endpoint}`, apiKey);
    if (voices !== null) {
      return voices;
    }
  }

  ttsLogger.info({
    event: 'tts.voice_resolution.custom_endpoint.voices_unsupported',
    degraded: true,
    fallbackPath: 'provider_default_voices',
  }, 'Custom endpoint does not support voices, using defaults');
  return null;
}

export async function resolveVoices({ provider, model, apiKey = '', baseUrl = '' }: ResolveVoicesOptions): Promise<string[]> {
  if (provider === 'openrouter') {
    const models = await fetchOpenRouterModels();
    return models.find(entry => entry.id === model)?.supportedVoices?.length
      ? models.find(entry => entry.id === model)!.supportedVoices!
      : resolveTtsProviderModelPolicy({ providerRef: provider, model }).defaultVoices;
  }
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: provider,
    providerType: provider,
    model,
  });
  const defaultVoices = providerModelPolicy.defaultVoices;
  const voiceSource = providerModelPolicy.voiceSource;

  if (voiceSource === 'custom-openai-api') {
    if (baseUrl) {
      const apiVoices = await fetchCustomOpenAiVoices(baseUrl, apiKey);
      if (apiVoices !== null) {
        return apiVoices;
      }
    }
    // No voices endpoint resolved on this OpenAI-compatible server. Fall back to the
    // canonical OpenAI voices, which every OpenAI-compatible endpoint accepts.
    return defaultVoices.length > 0 ? defaultVoices : [...OPENAI_DEFAULT_VOICES];
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
