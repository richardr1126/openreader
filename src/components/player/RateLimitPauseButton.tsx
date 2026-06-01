'use client';

import { PauseIcon } from '@/components/icons/Icons';
import { useTTS } from '@/contexts/TTSContext';
import { IconButton } from '@/components/ui';

export function RateLimitPauseButton() {
  const { isPlaying, togglePlay } = useTTS();

  // Only show while audio is actively playing. This avoids presenting a "play" affordance
  // when the user is rate-limited.
  if (!isPlaying) return null;

  return (
    <IconButton
      onClick={() => {
        if (isPlaying) togglePlay();
      }}
      aria-label="Pause"
    >
      <PauseIcon className="w-5 h-5" />
    </IconButton>
  );
}
