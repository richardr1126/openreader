'use client';

import { Input, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { ChevronUpDownIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { useConfig } from '@/contexts/ConfigContext';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const SpeedControl = ({ 
  setSpeedAndRestart, 
  setAudioPlayerSpeedAndRestart 
}: {
  setSpeedAndRestart: (speed: number) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
}) => {
  const { voiceSpeed, audioPlayerSpeed } = useConfig();

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
      if (localVoiceSpeed !== 1.0) parts.push(`${formatSpeed(localVoiceSpeed, 1)}x`);
      if (localAudioSpeed !== 1.0) parts.push(`${formatSpeed(localAudioSpeed, 1)}x`);
      return parts.length > 0 ? parts.join(' • ') : '1x';
    },
    [formatSpeed, localVoiceSpeed, localAudioSpeed]
  );

  const compactTriggerLabel = useMemo(() => {
    const voiceIsDefault = localVoiceSpeed === 1.0;
    const audioIsDefault = localAudioSpeed === 1.0;

    let combined = 1.0;
    if (!voiceIsDefault && !audioIsDefault) {
      combined = (localVoiceSpeed + localAudioSpeed) / 2;
    } else if (!voiceIsDefault) {
      combined = localVoiceSpeed;
    } else if (!audioIsDefault) {
      combined = localAudioSpeed;
    }

    return `${formatSpeed(combined, 2)}x`;
  }, [formatSpeed, localVoiceSpeed, localAudioSpeed]);

  const min = 0.5;
  const max = 3;
  const step = 0.1;

  return (
    <Popover className="relative">
      <PopoverButton className="flex items-center space-x-0.5 sm:space-x-1 bg-transparent text-foreground text-xs sm:text-sm focus:outline-none cursor-pointer hover:bg-offbase rounded pl-1.5 sm:pl-2 pr-0.5 sm:pr-1 py-0.5 sm:py-1 transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent">
        <SpeedometerIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
        <span className="sm:hidden">{compactTriggerLabel}</span>
        <span className="hidden sm:inline">{triggerLabel}</span>
        <ChevronUpDownIcon className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
      </PopoverButton>
      <PopoverPanel anchor="top" className="absolute z-50 bg-base p-3 rounded-md shadow-lg border border-offbase">
        <div className="flex flex-col space-y-4">
          <div className="flex flex-col space-y-2">
            <div className="text-xs font-medium text-foreground">Native model speed</div>
            <div className="flex justify-between">
              <span className="text-xs">{min.toFixed(1)}x</span>
              <span className="text-xs font-bold">
                {Number.isInteger(localVoiceSpeed) ? localVoiceSpeed.toString() : localVoiceSpeed.toFixed(1)}x
              </span>
              <span className="text-xs">{max.toFixed(1)}x</span>
            </div>
            <Input
              type="range"
              min={min}
              max={max}
              step={step}
              value={localVoiceSpeed}
              onChange={handleVoiceSpeedChange}
              onMouseUp={handleVoiceSpeedChangeComplete}
              onKeyUp={handleVoiceSpeedChangeComplete}
              onTouchEnd={handleVoiceSpeedChangeComplete}
              className="w-full bg-offbase rounded-lg appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-lg [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent"
            />
          </div>

          <div className="flex flex-col space-y-2">
            <div className="text-xs font-medium text-foreground">Audio player speed</div>
            <div className="flex justify-between">
              <span className="text-xs">{min.toFixed(1)}x</span>
              <span className="text-xs font-bold">
                {Number.isInteger(localAudioSpeed) ? localAudioSpeed.toString() : localAudioSpeed.toFixed(1)}x
              </span>
              <span className="text-xs">{max.toFixed(1)}x</span>
            </div>
            <Input
              type="range"
              min={min}
              max={max}
              step={step}
              value={localAudioSpeed}
              onChange={handleAudioSpeedChange}
              onMouseUp={handleAudioSpeedChangeComplete}
              onKeyUp={handleAudioSpeedChangeComplete}
              onTouchEnd={handleAudioSpeedChangeComplete}
              className="w-full bg-offbase rounded-lg appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-lg [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent"
            />
          </div>
        </div>
      </PopoverPanel>
    </Popover>
  );
};
