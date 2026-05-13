import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';

function normalizeInstructionCandidate(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve effective TTS instructions for a request.
 *
 * Priority:
 * 1) explicit per-request instructions
 * 2) shared-provider default instructions
 *
 * Returns `undefined` when the model does not support instructions or when
 * neither source provides a non-empty value.
 */
export function resolveEffectiveTtsInstructions(opts: {
  model: string | null | undefined;
  requestInstructions?: string | null;
  sharedDefaultInstructions?: string | null;
}): string | undefined {
  if (!resolveTtsProviderModelPolicy({
    providerRef: '',
    providerType: 'custom-openai',
    model: opts.model,
  }).supportsInstructions) {
    return undefined;
  }

  return normalizeInstructionCandidate(opts.requestInstructions)
    ?? normalizeInstructionCandidate(opts.sharedDefaultInstructions);
}
