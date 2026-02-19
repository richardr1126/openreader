'use client';

import { Button } from '@headlessui/react';
import { PauseIcon } from '@/components/icons/Icons';
import { useTTS } from '@/contexts/TTSContext';

export function RateLimitPauseButton() {
  const { isPlaying, togglePlay } = useTTS();

  // Only show while audio is actively playing. This avoids presenting a "play" affordance
  // when the user is rate-limited.
  if (!isPlaying) return null;

  return (
    <Button
      onClick={() => {
        if (isPlaying) togglePlay();
      }}
      className="relative p-1.5 rounded-md text-foreground hover:bg-offbase transition-all duration-200 focus:outline-none h-8 w-8 flex items-center justify-center transform ease-in-out hover:scale-[1.09] hover:text-accent"
      aria-label="Pause"
    >
      <PauseIcon className="w-5 h-5" />
    </Button>
  );
}
