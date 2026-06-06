'use client';

import { ChevronUpDownIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { useConfig } from '@/contexts/ConfigContext';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { PopoverRoot, PopoverSurface, PopoverTrigger, RangeInput } from '@/components/ui';

export const SpeedControl = ({ 
  setSpeedAndRestart, 
  setAudioPlayerSpeedAndRestart 
}: {
  setSpeedAndRestart: (speed: number) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
}) => {
  const { voiceSpeed, audioPlayerSpeed, providerType, ttsModel } = useConfig();
  const nativeSpeedSupported = resolveTtsProviderModelPolicy({
    providerRef: '',
    providerType,
    model: ttsModel,
  }).supportsNativeModelSpeed;

  const [localVoiceSpeed, setLocalVoiceSpeed] = useState(voiceSpeed);
  const [localAudioSpeed, setLocalAudioSpeed] = useState(audioPlayerSpeed);

  useEffect(() => {
    setLocalVoiceSpeed(voiceSpeed);
  }, [voiceSpeed]);

  useEffect(() => {
    setLocalAudioSpeed(audioPlayerSpeed);
  }, [audioPlayerSpeed]);

  const handleVoiceSpeedChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalVoiceSpeed(parseFloat(event.target.value));
  }, []);

  const handleAudioSpeedChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalAudioSpeed(parseFloat(event.target.value));
  }, []);

  const handleVoiceSpeedChangeComplete = useCallback(() => {
    if (localVoiceSpeed !== voiceSpeed) {
      setSpeedAndRestart(localVoiceSpeed);
    }
  }, [localVoiceSpeed, voiceSpeed, setSpeedAndRestart]);

  const handleAudioSpeedChangeComplete = useCallback(() => {
    if (localAudioSpeed !== audioPlayerSpeed) {
      setAudioPlayerSpeedAndRestart(localAudioSpeed);
    }
  }, [localAudioSpeed, audioPlayerSpeed, setAudioPlayerSpeedAndRestart]);

  const formatSpeed = useCallback((speed: number, maxDecimals: number) => {
    const rounded = Number(speed.toFixed(maxDecimals));
    return rounded.toString();
  }, []);

  const triggerLabel = useMemo(
    () => {
      const parts: string[] = [];
      if (nativeSpeedSupported && localVoiceSpeed !== 1.0) parts.push(`${formatSpeed(localVoiceSpeed, 1)}x`);
      if (localAudioSpeed !== 1.0) parts.push(`${formatSpeed(localAudioSpeed, 1)}x`);
      return parts.length > 0 ? parts.join(' • ') : '1x';
    },
    [formatSpeed, localVoiceSpeed, localAudioSpeed, nativeSpeedSupported]
  );

  const compactTriggerLabel = useMemo(() => {
    const voiceIsDefault = !nativeSpeedSupported || localVoiceSpeed === 1.0;
    const audioIsDefault = localAudioSpeed === 1.0;

    let combined = 1.0;
    if (nativeSpeedSupported && !voiceIsDefault && !audioIsDefault) {
      combined = (localVoiceSpeed + localAudioSpeed) / 2;
    } else if (nativeSpeedSupported && !voiceIsDefault) {
      combined = localVoiceSpeed;
    } else if (!audioIsDefault) {
      combined = localAudioSpeed;
    }

    return `${formatSpeed(combined, 2)}x`;
  }, [formatSpeed, localVoiceSpeed, localAudioSpeed, nativeSpeedSupported]);

  const min = 0.5;
  const max = 3;
  const step = 0.1;

  return (
    <PopoverRoot className="relative">
      <PopoverTrigger className="space-x-0.5 px-1.5 py-0.5 text-xs sm:space-x-1 sm:px-2 sm:py-1 sm:text-sm">
        <SpeedometerIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
        <span className="sm:hidden">{compactTriggerLabel}</span>
        <span className="hidden sm:inline">{triggerLabel}</span>
        <ChevronUpDownIcon className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
      </PopoverTrigger>
      <PopoverSurface anchor="top">
        <div className="flex flex-col space-y-4">
          {!nativeSpeedSupported && (
            <div className="rounded-md border border-line bg-background px-2 py-1.5 text-[11px] text-soft">
              Native model speed is not available for this model.
            </div>
          )}

          {nativeSpeedSupported && (
            <div className="flex flex-col space-y-2">
              <div className="text-xs font-medium text-foreground">Native model speed</div>
              <div className="flex justify-between">
                <span className="text-xs">{min.toFixed(1)}x</span>
                <span className="text-xs font-bold">
                  {Number.isInteger(localVoiceSpeed) ? localVoiceSpeed.toString() : localVoiceSpeed.toFixed(1)}x
                </span>
                <span className="text-xs">{max.toFixed(1)}x</span>
              </div>
              <RangeInput
                min={min}
                max={max}
                step={step}
                value={localVoiceSpeed}
                onChange={handleVoiceSpeedChange}
                onMouseUp={handleVoiceSpeedChangeComplete}
                onKeyUp={handleVoiceSpeedChangeComplete}
                onTouchEnd={handleVoiceSpeedChangeComplete}
              />
            </div>
          )}

          <div className="flex flex-col space-y-2">
            <div className="text-xs font-medium text-foreground">Audio player speed</div>
            <div className="flex justify-between">
              <span className="text-xs">{min.toFixed(1)}x</span>
              <span className="text-xs font-bold">
                {Number.isInteger(localAudioSpeed) ? localAudioSpeed.toString() : localAudioSpeed.toFixed(1)}x
              </span>
              <span className="text-xs">{max.toFixed(1)}x</span>
            </div>
            <RangeInput
              min={min}
              max={max}
              step={step}
              value={localAudioSpeed}
              onChange={handleAudioSpeedChange}
              onMouseUp={handleAudioSpeedChangeComplete}
              onKeyUp={handleAudioSpeedChangeComplete}
              onTouchEnd={handleAudioSpeedChangeComplete}
            />
          </div>
        </div>
      </PopoverSurface>
    </PopoverRoot>
  );
};
