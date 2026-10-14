'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { WORD_HIGHLIGHT_LEAD_SEC } from '@/lib/client/tts/playback-grid';
import {
  findActiveDemoWord,
  splitDemoSentence,
  type ActiveDemoWord,
  type DemoTextPart,
  type ReaderDemo,
} from './reader-demo-timeline';

/** `loading` covers the fetch before the first frame and any later stall. */
export type DemoStatus = 'paused' | 'loading' | 'playing';

function sameWord(a: ActiveDemoWord | null, b: ActiveDemoWord | null): boolean {
  return a?.sentence === b?.sentence && a?.word === b?.word;
}

export interface ReaderDemoState {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Spread onto the `<audio>` element; the element is the only clock. */
  audioProps: {
    src: string;
    preload: 'none';
    onPlay: () => void;
    onPlaying: () => void;
    onWaiting: () => void;
    onPause: () => void;
    onEnded: () => void;
    onError: () => void;
  };
  status: DemoStatus;
  running: boolean;
  active: ActiveDemoWord | null;
  elapsedSec: number;
  failed: boolean;
  sentences: DemoTextPart[][];
  toggle: () => void;
}

/**
 * Playback state for a design's read-along sample. One frame loop projects the
 * audio clock onto the highlight (with the reader's lead) and writes a
 * `--progress` (0–1) custom property onto `progressRef` so designs can animate
 * progress without a React render per frame.
 */
export function useReaderDemo(
  demo: ReaderDemo,
  progressRef?: RefObject<HTMLElement | null>,
): ReaderDemoState {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<DemoStatus>('paused');
  const running = status !== 'paused';
  const [active, setActive] = useState<ActiveDemoWord | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [failed, setFailed] = useState(false);

  const sentences = useMemo(
    () => demo.sentences.map((sentence) => splitDemoSentence(sentence)),
    [demo.sentences],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!running || !audio) return;
    let frame = 0;
    const tick = () => {
      const next = findActiveDemoWord(demo.sentences, audio.currentTime + WORD_HIGHLIGHT_LEAD_SEC);
      setActive((prev) => (sameWord(prev, next) ? prev : next));
      setElapsedSec(Math.floor(audio.currentTime));
      progressRef?.current?.style.setProperty(
        '--progress',
        String(Math.min(1, audio.currentTime / demo.durationSec)),
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, demo.sentences, demo.durationSec, progressRef]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setFailed(false);
      void audio.play().catch((error: unknown) => {
        setStatus('paused');
        // A pause during startup aborts play(); only a real failure is reported.
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    } else {
      audio.pause();
    }
  };

  const reset = () => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = 0;
    progressRef?.current?.style.setProperty('--progress', '0');
    setStatus('paused');
    setActive(null);
    setElapsedSec(0);
  };

  return {
    audioRef,
    audioProps: {
      src: demo.audioSrc,
      preload: 'none',
      onPlay: () => setStatus('loading'),
      onPlaying: () => setStatus('playing'),
      onWaiting: () => setStatus('loading'),
      onPause: () => setStatus('paused'),
      onEnded: reset,
      onError: () => {
        setStatus('paused');
        setFailed(true);
      },
    },
    status,
    running,
    active,
    elapsedSec,
    failed,
    sentences,
    toggle,
  };
}
