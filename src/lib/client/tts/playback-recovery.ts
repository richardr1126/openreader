import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import { isPlaybackStartBufferReady } from '@/lib/client/tts/playback-control';

/** Watch the local media clock; readiness comes from the existing SSE read model. */
export function createPlaybackRecovery<T>(input: {
  isCurrent: () => boolean;
  currentTime: () => number;
  readyTarget: () => T | null;
  reconnect: (target: T) => void;
  onExhausted: () => void;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let lastTime = input.currentTime();
  let lastAdvance = now();
  let attempts = 0;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const time = input.currentTime();
    if (!input.isCurrent() || Math.abs(time - lastTime) > 0.05) {
      lastTime = time;
      lastAdvance = now();
      attempts = 0;
      return;
    }
    if (now() - lastAdvance < 5_000) return;
    const target = input.readyTarget();
    if (target === null) return; // Still generating: reloading cannot help.
    lastAdvance = now();
    if (attempts >= 2) {
      attempts = 0;
      input.onExhausted();
      return;
    }
    attempts++;
    input.reconnect(target);
    lastTime = input.currentTime(); // A media reload is not audible progress.
  };
  const timer = setInterval(check, 1_000);
  return { check, stop: () => { stopped = true; clearInterval(timer); } };
}

/** Reopen a dead media connection without replacing its canonical session. */
export function createTtsMediaRecovery(input: {
  audio: HTMLAudioElement;
  sessionUrl: string;
  isCurrent: () => boolean;
  getDocumentTime: () => number;
  getOrdinal: () => number | null;
  getLayout: () => TtsPlaybackSeekLayout | null;
  setStreamBase: (seconds: number) => void;
  onBuffering: () => void;
  onExhausted: () => void;
}) {
  return createPlaybackRecovery({
    isCurrent: input.isCurrent,
    currentTime: input.getDocumentTime,
    readyTarget: () => {
      const layout = input.getLayout();
      const ordinal = input.getOrdinal();
      const slot = layout?.segments.find((segment) => segment.ordinal === ordinal);
      if (!layout || !slot?.generated) return null;
      const documentTime = input.getDocumentTime();
      return isPlaybackStartBufferReady({
        segments: layout.segments, startOrdinal: slot.ordinal, playbackRate: input.audio.playbackRate,
        offsetWithinStartSegmentMs: Math.max(0, documentTime * 1000 - slot.startMs),
      }) ? { slot, documentTime } : null;
    },
    reconnect: ({ slot, documentTime }) => {
      const url = new URL(input.sessionUrl, window.location.href);
      url.searchParams.set('fromOrdinal', String(slot.ordinal));
      input.setStreamBase(slot.startMs / 1000);
      input.audio.src = url.toString();
      input.audio.load();
      input.audio.currentTime = Math.max(0, documentTime - slot.startMs / 1000);
      input.onBuffering();
      void input.audio.play().catch(() => undefined);
    },
    onExhausted: input.onExhausted,
  });
}
