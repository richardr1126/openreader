'use client';

import { ChevronUpDownIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { useConfig } from '@/contexts/ConfigContext';
import { useCallback, useEffect, useState } from 'react';
import { PopoverRoot, PopoverSurface, PopoverTrigger, RangeInput } from '@/components/ui';

const MIN_SPEED = 0.5;
const MAX_SPEED = 3;

function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}

/**
 * Browser playback rate. It changes instantly and never regenerates audio;
 * the model's own speaking speed lives in the voice panel.
 */
export const SpeedControl = ({
  disabled = false,
  setAudioPlayerSpeedAndRestart,
}: {
  disabled?: boolean;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
}) => {
  const { audioPlayerSpeed } = useConfig();
  const [localAudioSpeed, setLocalAudioSpeed] = useState(audioPlayerSpeed);

  useEffect(() => {
    setLocalAudioSpeed(audioPlayerSpeed);
  }, [audioPlayerSpeed]);

  const handleAudioSpeedChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalAudioSpeed(parseFloat(event.target.value));
  }, []);

  const handleAudioSpeedChangeComplete = useCallback(() => {
    if (localAudioSpeed !== audioPlayerSpeed) {
      setAudioPlayerSpeedAndRestart(localAudioSpeed);
    }
  }, [localAudioSpeed, audioPlayerSpeed, setAudioPlayerSpeedAndRestart]);

  return (
    <PopoverRoot className="relative">
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Playback speed ${formatSpeed(localAudioSpeed)}`}
        className="space-x-0.5 px-1.5 py-0.5 text-xs sm:space-x-1 sm:px-2 sm:py-1 sm:text-sm disabled:cursor-wait disabled:opacity-60"
      >
        <SpeedometerIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
        <span>{formatSpeed(localAudioSpeed)}</span>
        <ChevronUpDownIcon className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
      </PopoverTrigger>
      <PopoverSurface anchor="top">
        <div className="flex flex-col space-y-2">
          <div className="text-xs font-medium text-foreground">Playback speed</div>
          <div className="flex justify-between">
            <span className="text-xs">{formatSpeed(MIN_SPEED)}</span>
            <span className="text-xs font-bold">{formatSpeed(localAudioSpeed)}</span>
            <span className="text-xs">{formatSpeed(MAX_SPEED)}</span>
          </div>
          <RangeInput
            aria-label="Audio player speed"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.1}
            value={localAudioSpeed}
            onChange={handleAudioSpeedChange}
            onMouseUp={handleAudioSpeedChangeComplete}
            onKeyUp={handleAudioSpeedChangeComplete}
            onTouchEnd={handleAudioSpeedChangeComplete}
          />
          <p className="max-w-48 text-[11px] leading-snug text-soft">
            Applies instantly without regenerating audio.
          </p>
        </div>
      </PopoverSurface>
    </PopoverRoot>
  );
};
