'use client';

import { resolveProviderDefaults } from '@openreader/tts/provider-policy';
import { ChoiceTile, Section } from '@/components/ui';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { formatModelSpeed } from '@/lib/client/tts/voice-draft';
import type { BookVoiceChange } from '@/hooks/audio/useTtsPlaybackSettings';
import type { CachedVoiceResource } from '@/types/voice-api';

function formatLength(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 min';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The book voice change that reuses a cached voice, switching provider and model when it needs to. */
export function cachedVoiceChange(
  entry: CachedVoiceResource,
  sharedProviders: Parameters<typeof resolveProviderDefaults>[0]['sharedProviders'],
): Required<Pick<BookVoiceChange, 'voice' | 'nativeSpeed'>> & BookVoiceChange {
  const { providerType } = resolveProviderDefaults({ providerRef: entry.provider, sharedProviders });
  return {
    voice: entry.voice,
    nativeSpeed: entry.modelSpeed,
    target: { providerRef: entry.provider, providerType, ttsModel: entry.model },
  };
}

/**
 * Voices this book already has audio for. Picking one reuses that audio
 * instead of generating it again. An entry on another provider or model
 * says so, because using it switches the provider for every book.
 */
export function CachedVoiceList({
  voices,
  current,
  onPick,
  disabled = false,
}: {
  voices: CachedVoiceResource[];
  current: { providerRef: string; ttsModel: string; voice: string; nativeSpeed: number };
  onPick: (entry: CachedVoiceResource) => void;
  disabled?: boolean;
}) {
  const { providers } = useSharedProviders();
  if (voices.length === 0) return null;
  const providerName = (ref: string) => providers.find((entry) => entry.slug === ref)?.displayName || ref;
  return (
    <Section title="Cached for this book" variant="group">
      <ul aria-label="Cached voices" className="space-y-1.5">
        {voices.map((entry) => {
          const elsewhere = entry.provider !== current.providerRef || entry.model !== current.ttsModel;
          const selected = !elsewhere && entry.voice === current.voice && entry.modelSpeed === current.nativeSpeed;
          const detail = [
            ...(elsewhere ? [`${providerName(entry.provider)} · ${entry.model}`] : []),
            ...(entry.modelSpeed !== 1 ? [formatModelSpeed(entry.modelSpeed)] : []),
            formatLength(entry.durationMs),
          ].join(' · ');
          return (
            <li key={`${entry.provider}/${entry.model}/${entry.voice}/${entry.modelSpeed}`}>
              <ChoiceTile
                selected={selected}
                disabled={disabled}
                onClick={() => onPick(entry)}
                className="w-full flex-col items-start gap-0.5 disabled:opacity-60"
              >
                <span className="text-sm text-foreground">{entry.name}</span>
                <span className="text-xs text-faint">{detail}</span>
                {elsewhere && <span className="text-[11px] text-soft">Switches your provider for all books.</span>}
              </ChoiceTile>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
