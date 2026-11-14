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
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    let context: AudioContextType;
    try {
      context = new AudioContextClass();
    } catch (error) {
      console.error('Failed to initialize AudioContext:', error);
      return;
    }
    // The context is a browser resource this effect creates and closes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAudioContext(context);
    return () => {
      context.close().catch((error) => {
        console.error('Error closing AudioContext:', error);
      });
    };
  }, []);

  return audioContext;
}
