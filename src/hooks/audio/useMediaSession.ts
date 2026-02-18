'use client';

import { useEffect } from 'react';

interface MediaControls {
  togglePlay: () => void;
  skipForward: () => void;
  skipBackward: () => void;
}

/**
 * Custom hook for managing media session controls
 * @param controls Object containing media control functions
 */
export function useMediaSession(controls: MediaControls) {
  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Text-to-Speech',
        artist: 'OpenReader',
        album: 'Current Document',
      });

      navigator.mediaSession.setActionHandler('play', () => controls.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => controls.togglePlay());
      navigator.mediaSession.setActionHandler('nexttrack', () => controls.skipForward());
      navigator.mediaSession.setActionHandler('previoustrack', () => controls.skipBackward());
    }
  }, [controls]);
}
