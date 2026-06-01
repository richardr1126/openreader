'use client';

import { useTTS } from '@/contexts/TTSContext';
import {
  PlayIcon,
  PauseIcon,
  SkipForwardIcon,
  SkipBackwardIcon,
} from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { VoicesControl } from '@/components/player/VoicesControl';
import { SpeedControl } from '@/components/player/SpeedControl';
import { Navigator } from '@/components/player/Navigator';
import { IconButton } from '@/components/ui';

export default function TTSPlayer({ currentPage, numPages }: {
  currentPage?: number;
  numPages?: number | undefined;
}) {
  const {
    isPlaying,
    togglePlay,
    skipForward,
    skipBackward,
    isProcessing,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    availableVoices,
    skipToLocation,
  } = useTTS();

  return (
    <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
      <div className="px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-1 min-h-10">
        {/* Speed control */}
        <SpeedControl 
          setSpeedAndRestart={setSpeedAndRestart} 
          setAudioPlayerSpeedAndRestart={setAudioPlayerSpeedAndRestart}
        />

        {/* Page Navigation */}
        {currentPage && numPages && (
          <Navigator 
            currentPage={currentPage} 
            numPages={numPages} 
            skipToLocation={skipToLocation}
          />
        )}

        {/* Playback Controls */}
        <IconButton
          onClick={skipBackward}
          aria-label="Skip backward"
          disabled={isProcessing}
        >
          {isProcessing ? <LoadingSpinner /> : <SkipBackwardIcon className="w-5 h-5" />}
        </IconButton>

        <IconButton
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={isProcessing && !isPlaying}
        >
          {isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />}
        </IconButton>

        <IconButton
          onClick={skipForward}
          aria-label="Skip forward"
          disabled={isProcessing}
        >
          {isProcessing ? <LoadingSpinner /> : <SkipForwardIcon className="w-5 h-5" />}
        </IconButton>

        {/* Voice control */}
        <VoicesControl availableVoices={availableVoices} setVoiceAndRestart={setVoiceAndRestart} />
      </div>
    </div>
  );
}
