'use client';

import { useState, useEffect } from 'react';

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

// Type definition for AudioContext to handle browser compatibility
type AudioContextType = typeof window extends undefined
  ? never
  : (AudioContext);

/**
 * Custom hook for managing AudioContext
 * @returns AudioContext instance or undefined
 */
export function useAudioContext() {
  const [audioContext, setAudioContext] = useState<AudioContextType>();

  useEffect(() => {
    if (typeof window !== 'undefined' && !audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        try {
          setAudioContext(new AudioContextClass());
        } catch (error) {
          console.error('Failed to initialize AudioContext:', error);
        }
      }
    }

    return () => {
      if (audioContext) {
        audioContext.close().catch((error) => {
          console.error('Error closing AudioContext:', error);
        });
      }
    };
  }, [audioContext]);

  return audioContext;
}
