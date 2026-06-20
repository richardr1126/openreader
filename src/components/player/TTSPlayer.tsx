'use client';

import { useMemo, useState } from 'react';
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

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function TTSPlayer({ currentPage, numPages, isPlaybackReady = true }: {
  currentPage?: number;
  numPages?: number | undefined;
  isPlaybackReady?: boolean;
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
    currentSentence,
    playbackSegments,
    playbackTimeSec,
    playbackDurationSec,
    playbackSeekLayout,
    seekPlaybackTo,
  } = useTTS();
  const [previewSec, setPreviewSec] = useState<number | null>(null);
  const shownSec = previewSec ?? playbackTimeSec;
  const previewSegment = useMemo(() => {
    if (!playbackSeekLayout) return null;
    const ms = shownSec * 1000;
    return playbackSeekLayout.segments.find((segment) => ms >= segment.startMs && ms < segment.endMs)
      ?? playbackSeekLayout.segments.at(-1)
      ?? null;
  }, [playbackSeekLayout, shownSec]);
  const previewText = previewSegment
    ? (playbackSegments.find((segment) => segment.ordinal === previewSegment.ordinal)?.text || currentSentence)
    : currentSentence;
  const canSeek = playbackDurationSec > 0 && Boolean(playbackSeekLayout);

  return (
    <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
      {/* Single centered column; its width is driven by the controls row so the
          scrubber and status text line up to exactly that width. */}
      <div className="mx-auto flex w-fit flex-col items-stretch gap-1 px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {/* Now-playing / seek-preview text */}
        <div className="w-0 min-w-full truncate text-center text-[11px] text-soft">
          {previewSegment
            ? `${previewSegment.estimated ? 'Estimated' : 'Ready'} · ${previewText || `Segment ${previewSegment.ordinal + 1}`}`
            : (currentSentence || 'Playback position')}
        </div>

        {/* Scrubber — full width of the column (== controls row width) */}
        <div className="flex w-full items-center gap-2 text-[11px] text-soft">
          <span className="w-10 tabular-nums text-right">{formatTime(shownSec)}</span>
          <input
            aria-label="Playback position"
            type="range"
            min={0}
            max={Math.max(0, Math.round(playbackDurationSec))}
            step={0.25}
            value={Math.min(Math.max(0, shownSec), Math.max(0, playbackDurationSec))}
            disabled={!canSeek}
            onChange={(event) => setPreviewSec(Number(event.currentTarget.value))}
            onPointerUp={(event) => {
              const target = Number((event.currentTarget as HTMLInputElement).value);
              setPreviewSec(null);
              seekPlaybackTo(target);
            }}
            onKeyUp={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              const target = Number((event.currentTarget as HTMLInputElement).value);
              setPreviewSec(null);
              seekPlaybackTo(target);
            }}
            className="h-2 min-w-0 flex-1 accent-foreground disabled:opacity-40"
          />
          <span className="w-10 tabular-nums">{formatTime(playbackDurationSec)}</span>
        </div>

        {/* Playback controls */}
        <div className="flex min-h-10 items-center justify-center gap-1">
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
            disabled={isProcessing || !isPlaybackReady}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipBackwardIcon className="w-5 h-5" />}
          </IconButton>

          <IconButton
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            disabled={!isPlaying && (!isPlaybackReady || isProcessing)}
            className="relative"
          >
            {!isPlaying && !isPlaybackReady
              ? <LoadingSpinner />
              : (isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />)}
          </IconButton>

          <IconButton
            onClick={skipForward}
            aria-label="Skip forward"
            disabled={isProcessing || !isPlaybackReady}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipForwardIcon className="w-5 h-5" />}
          </IconButton>

          {/* Voice control */}
          <VoicesControl availableVoices={availableVoices} setVoiceAndRestart={setVoiceAndRestart} />
        </div>
      </div>
    </div>
  );
}
