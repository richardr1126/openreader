'use client';

import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { AudioWaveIcon, InfoIcon } from '@/components/icons/Icons';
import { getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { formatVoiceDockLabel } from '@/lib/client/tts/voice-draft';

/** The dock's voice button: shows the applied voice and opens the voice panel. */
export const VoicesControl = ({ disabled = false, onOpen }: {
  disabled?: boolean;
  onOpen: () => void;
}) => {
  const { ttsModel, providerRef, providerType, voiceSpeed } = useConfig();
  const { voice, resolvedLanguage } = useTTS();
  const policy = resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel });
  const label = formatVoiceDockLabel({
    voice: voice || '',
    nativeSpeed: voiceSpeed,
    supportsNativeModelSpeed: policy.supportsNativeModelSpeed,
  });
  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    voice,
    documentLanguage: resolvedLanguage,
  });

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={`Voice: ${label}`}
        aria-haspopup="dialog"
        className="inline-flex max-w-[11rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-foreground transition-colors duration-fast hover:bg-accent-wash hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60 sm:max-w-[16rem] sm:px-2 sm:py-1 sm:text-sm"
      >
        <AudioWaveIcon className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
        <span className="truncate">{label}</span>
      </button>
      {languageWarnings.length > 0 ? (
        <span
          aria-label="Voice language warning"
          title={languageWarnings.join(' ')}
          className="text-warning"
        >
          <InfoIcon className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </div>
  );
};
