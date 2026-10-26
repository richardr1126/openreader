import type { TtsProviderId } from '@openreader/tts/provider-catalog';
import {
  defaultBaseUrlForProviderType,
  defaultModelForProviderType,
  defaultVoiceForProviderType,
} from '@openreader/tts/provider-policy';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import type { TtsVoicePreviewResult } from '@/lib/server/compute-worker/client';
import type { TtsVoicePreviewRequest } from '@/lib/server/compute-worker/protocol';
import type { ProviderCheckItem } from '@/lib/shared/provider-check';

/** The provider as the admin dialog currently describes it. */
export interface ProviderCheckDraft {
  providerType: TtsProviderId;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  defaultInstructions: string;
}

/**
 * The saved provider a draft edits. Only a saved, unchanged provider can speak
 * a sample, because the worker resolves credentials by slug from the broker.
 */
export interface ProviderCheckSaved {
  slug: string;
  enabled: boolean;
  matchesDraft: boolean;
}

export interface ProviderCheckDeps {
  fetch: typeof fetch;
  resolveVoices: typeof resolveVoices;
  workerAvailable: () => boolean;
  synthesizePreview: (input: TtsVoicePreviewRequest, signal: AbortSignal) => Promise<TtsVoicePreviewResult>;
}

const PROBE_TIMEOUT_MS = 10_000;
const SPEECH_TIMEOUT_MS = 35_000;
const SAMPLE_TEXT = 'This is a quick provider check.';
const KEY_REQUIRED: readonly TtsProviderId[] = ['openai', 'deepinfra', 'replicate', 'fish-audio'];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function checkSettings(draft: ProviderCheckDraft): ProviderCheckItem {
  const item = (status: ProviderCheckItem['status'], detail: string): ProviderCheckItem => ({
    id: 'settings',
    label: 'Settings',
    status,
    detail,
  });
  if (draft.providerType === 'custom-openai') {
    if (!draft.baseUrl) return item('error', 'Add the base URL of the OpenAI-compatible server.');
    let parsed: URL;
    try {
      parsed = new URL(draft.baseUrl);
    } catch {
      return item('error', 'The base URL is not a valid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return item('error', 'The base URL must start with http:// or https://.');
    }
  }
  if (!draft.apiKey && KEY_REQUIRED.includes(draft.providerType)) {
    return item('error', 'This provider needs an API key.');
  }
  return item('ok', 'Required fields are filled in.');
}

function parseReplicateModel(model: string): string | null {
  const [ref, version] = model.split(':', 2);
  const [owner, name, extra] = ref.split('/');
  if (!owner || !name || extra !== undefined) return null;
  const base = `https://api.replicate.com/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return version ? `${base}/versions/${encodeURIComponent(version)}` : base;
}

async function checkConnection(
  draft: ProviderCheckDraft,
  model: string,
  deps: ProviderCheckDeps,
  signal: AbortSignal,
): Promise<ProviderCheckItem | null> {
  // The local Kokoro provider has no endpoint; the speech sample covers it.
  if (draft.providerType === 'kokoro-local') return null;
  const item = (status: ProviderCheckItem['status'], detail: string): ProviderCheckItem => ({
    id: 'connection',
    label: 'Connection',
    status,
    detail,
  });

  if (draft.providerType === 'replicate') {
    const endpoint = parseReplicateModel(model);
    if (!endpoint) return item('error', `${model} is not an owner/name Replicate model.`);
    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        headers: { Authorization: `Bearer ${draft.apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        cache: 'no-store',
      });
    } catch {
      return item('error', 'Could not reach api.replicate.com from the app server.');
    }
    if (response.status === 401 || response.status === 403) return item('error', 'Replicate rejected the API key.');
    if (response.status === 404) return item('error', `Replicate has no model ${model}.`);
    if (!response.ok) return item('warn', `Replicate answered HTTP ${response.status}.`);
    return item('ok', 'Replicate accepted the key and found the model.');
  }

  const baseUrl = (draft.baseUrl || defaultBaseUrlForProviderType(draft.providerType)).replace(/\/+$/, '');
  const host = hostOf(baseUrl);
  let response: Response;
  try {
    response = await deps.fetch(draft.providerType === 'fish-audio' ? 'https://api.fish.audio/model?page_size=1' : `${baseUrl}/models`, {
      headers: draft.apiKey ? { Authorization: `Bearer ${draft.apiKey}` } : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      cache: 'no-store',
    });
  } catch {
    return item('error', `Could not reach ${host} from the app server.`);
  }
  if (response.status === 401 || response.status === 403) return item('error', `${host} rejected the API key.`);
  // Many OpenAI-compatible TTS servers do not implement /models; an answer still proves reachability.
  if (response.status === 404 && draft.providerType === 'custom-openai') return item('ok', `Connected to ${host}.`);
  if (!response.ok) return item('warn', `${host} answered HTTP ${response.status}.`);

  if (draft.providerType === 'openai') {
    const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
    const ids = body?.data?.map((entry) => entry.id).filter((id): id is string => typeof id === 'string') ?? [];
    if (ids.length > 0 && !ids.includes(model)) {
      return item('warn', `Connected, but ${model} is not available to this key.`);
    }
  }
  return item('ok', `Connected to ${host}.`);
}

function speechSkipped(detail: string): ProviderCheckItem {
  return { id: 'speech', label: 'Speech sample', status: 'skipped', detail };
}

async function checkSpeech(
  draft: ProviderCheckDraft,
  model: string,
  voice: string,
  saved: ProviderCheckSaved | null,
  deps: ProviderCheckDeps,
  signal: AbortSignal,
): Promise<ProviderCheckItem> {
  if (!saved) return speechSkipped('Create the provider, then check it again to hear a sample.');
  if (!saved.matchesDraft) return speechSkipped('Save your changes, then check again to hear a sample.');
  if (!saved.enabled) return speechSkipped('Enable the provider to hear a sample.');
  if (!deps.workerAvailable()) return speechSkipped('No compute worker is configured.');

  const item = (status: ProviderCheckItem['status'], detail: string): ProviderCheckItem => ({
    id: 'speech',
    label: 'Speech sample',
    status,
    detail,
  });
  let result: TtsVoicePreviewResult;
  try {
    result = await deps.synthesizePreview({
      settings: {
        providerRef: saved.slug,
        providerType: draft.providerType,
        ttsModel: model,
        voice,
        nativeSpeed: 1,
        ...(draft.defaultInstructions ? { ttsInstructions: draft.defaultInstructions } : {}),
      },
      text: SAMPLE_TEXT,
    }, AbortSignal.any([signal, AbortSignal.timeout(SPEECH_TIMEOUT_MS)]));
  } catch {
    return item('error', 'The app could not reach the compute worker.');
  }
  if (result.ok) {
    const kb = Math.max(1, Math.round(result.audio.byteLength / 1024));
    return item('ok', `The worker spoke a sample with ${voice} (${kb} KB).`);
  }
  if (result.status === 429) return item('warn', 'The provider is busy or rate limited. Try again shortly.');
  if (result.status === 504 && draft.providerType === 'kokoro-local') {
    return item('warn', 'The sample timed out. Kokoro may still be downloading its model; check again in a few minutes.');
  }
  if (result.status === 504) return item('error', 'The speech sample timed out.');
  if (result.status === 503) return item('error', 'The worker could not load this provider\'s credentials.');
  if (result.code === 'UPSTREAM_ERROR') {
    return item('error', 'The provider rejected the request. Check the model, voice, and instructions.');
  }
  return item('error', `The speech sample failed${result.code ? ` (${result.code})` : ''}.`);
}

/**
 * Verifies a provider the way the app will use it: required settings, the
 * key against the provider's API, the voice list, and, for a saved provider,
 * one short sample spoken by the worker through the credential broker. The
 * key is used only for outbound provider requests and never appears in a result.
 */
export async function runProviderCheck(
  draft: ProviderCheckDraft,
  saved: ProviderCheckSaved | null,
  deps: ProviderCheckDeps,
  signal: AbortSignal,
): Promise<ProviderCheckItem[]> {
  const settings = checkSettings(draft);
  if (settings.status === 'error') return [settings];
  const model = draft.defaultModel || defaultModelForProviderType(draft.providerType);
  const items: ProviderCheckItem[] = [settings];

  const connection = await checkConnection(draft, model, deps, signal);
  if (connection) {
    items.push(connection);
    if (connection.status === 'error') return items;
  }

  let voices: string[] = [];
  try {
    voices = await deps.resolveVoices({
      provider: draft.providerType,
      model,
      apiKey: draft.apiKey,
      baseUrl: draft.baseUrl || defaultBaseUrlForProviderType(draft.providerType),
    });
  } catch {
    voices = [];
  }
  items.push(voices.length > 0
    ? { id: 'voices', label: 'Voices', status: 'ok', detail: `${voices.length} ${voices.length === 1 ? 'voice' : 'voices'} available.` }
    : { id: 'voices', label: 'Voices', status: 'warn', detail: 'No voices were found for this model.' });

  const preferredVoice = defaultVoiceForProviderType(draft.providerType);
  const voice = voices.includes(preferredVoice) ? preferredVoice : voices[0] ?? preferredVoice;
  items.push(await checkSpeech(draft, model, voice, saved, deps, signal));
  return items;
}
