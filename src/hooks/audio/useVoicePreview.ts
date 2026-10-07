'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchVoicePreview, VoicePreviewRequestError } from '@/lib/client/api/tts';
import type { TTSSegmentSettings } from '@/types/client';

export type VoicePreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' | 'playing'; key: string }
  | { phase: 'error'; key: string; message: string };

/**
 * Owns the one short voice sample the voice panel may be playing. It uses its
 * own detached audio element, never the playback element, so a preview cannot
 * touch the document timeline. Starting a preview aborts the previous one and
 * pauses document playback; document playback starting stops the preview.
 */
export function useVoicePreview(input: { isPlaying: boolean; pausePlayback: () => void }) {
  const { isPlaying, pausePlayback } = input;
  const [state, setState] = useState<VoicePreviewState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const release = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setState({ phase: 'idle' });
  }, [release]);

  const play = useCallback(async (key: string, request: { settings: TTSSegmentSettings; text: string }) => {
    release();
    if (isPlaying) pausePlayback();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: 'loading', key });
    try {
      const blob = await fetchVoicePreview(request, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      urlRef.current = url;
      audioRef.current = audio;
      audio.onended = () => {
        if (audioRef.current === audio) stop();
      };
      audio.onerror = () => {
        if (audioRef.current !== audio) return;
        release();
        setState({ phase: 'error', key, message: 'Preview could not be played.' });
      };
      await audio.play();
      if (audioRef.current === audio) setState({ phase: 'playing', key });
    } catch (error) {
      if (controller.signal.aborted) return;
      release();
      setState({
        phase: 'error',
        key,
        message: error instanceof VoicePreviewRequestError ? error.message : 'Preview is unavailable right now.',
      });
    }
  }, [isPlaying, pausePlayback, release, stop]);

  // Document playback wins: a preview never plays over it.
  useEffect(() => {
    if (isPlaying) stop();
  }, [isPlaying, stop]);

  useEffect(() => release, [release]);

  return { state, play, stop };
}
