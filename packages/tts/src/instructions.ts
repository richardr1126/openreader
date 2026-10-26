import { resolveTtsProviderModelPolicy } from './provider-policy';

function normalizeInstructionCandidate(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveEffectiveTtsInstructions(opts: {
  providerType?: import('./provider-catalog').TtsProviderType;
  model: string | null | undefined;
  requestInstructions?: string | null;
  sharedDefaultInstructions?: string | null;
}): string | undefined {
  if (!resolveTtsProviderModelPolicy({
    providerRef: '',
    providerType: opts.providerType ?? 'custom-openai',
    model: opts.model,
  }).supportsInstructions) {
    return undefined;
  }

  return normalizeInstructionCandidate(opts.requestInstructions)
    ?? normalizeInstructionCandidate(opts.sharedDefaultInstructions);
}
