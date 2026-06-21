'use client';

import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { useCallback } from 'react';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { InfoIcon } from '@/components/icons/Icons';
import { getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';

export const VoicesControl = ({ availableVoices, setVoiceAndRestart }: {
  availableVoices: string[];
  setVoiceAndRestart: (voice: string) => void;
}) => {
  const { ttsModel, providerType } = useConfig();
  const { voice, resolvedLanguage } = useTTS();
  const onChangeVoice = useCallback((nextVoice: string) => setVoiceAndRestart(nextVoice), [setVoiceAndRestart]);
  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    voice,
    documentLanguage: resolvedLanguage,
  });

  return (
    <div className="flex items-center gap-1">
      <VoicesControlBase
        availableVoices={availableVoices}
        voice={voice || ''}
        onChangeVoice={onChangeVoice}
        providerType={providerType}
        ttsModel={ttsModel}
      />
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
}
