'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { usePageTurnKeyboardControls } from '@/hooks/audio/usePlaybackKeyboardControls';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/icons/Icons';
import {
  IconButton, Input, PopoverRoot, PopoverSurface, PopoverTrigger, Tooltip,
} from '@/components/ui';

const pillStepButton = 'h-6 w-6 rounded-full';

/**
 * The reader's position cluster: previous · position · next. The player dock
 * floats it above its top edge, so it stays beside playback without taking a
 * toolbar row from the reading surface.
 */
export function ReaderPager({
  unit,
  onPrevious,
  onNext,
  canPrevious = true,
  canNext = true,
  position,
}: {
  /** Names the step, e.g. "page" or "section" ("Previous page"). */
  unit: string;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
  position: ReactNode;
}) {
  const { playbackShortcuts } = useConfig();
  usePageTurnKeyboardControls({ enabled: playbackShortcuts, onPrevious, onNext, canPrevious, canNext });

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip label={`Previous ${unit}`} shortcut={playbackShortcuts ? '⇧←' : undefined} side="top">
        <IconButton
          onClick={onPrevious}
          disabled={!canPrevious}
          aria-label={`Previous ${unit}`}
          aria-keyshortcuts={playbackShortcuts ? 'Shift+ArrowLeft' : undefined}
          size="sm"
          className={pillStepButton}
        >
          <ChevronLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </Tooltip>
      {position}
      <Tooltip label={`Next ${unit}`} shortcut={playbackShortcuts ? '⇧→' : undefined} side="top">
        <IconButton
          onClick={onNext}
          disabled={!canNext}
          aria-label={`Next ${unit}`}
          aria-keyshortcuts={playbackShortcuts ? 'Shift+ArrowRight' : undefined}
          size="sm"
          className={pillStepButton}
        >
          <ChevronRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </Tooltip>
    </div>
  );
}

/** A plain `current / total` readout. */
export function ReaderPosition({ current, total }: { current: number; total: number }) {
  return (
    <span className="whitespace-nowrap px-1.5 tabular-nums text-foreground">
      {current} / {total}
    </span>
  );
}

/** The page readout that opens a "go to page" field. */
export function PageJumpControl({
  currentPage,
  numPages,
  onGoToPage,
}: {
  currentPage: number;
  numPages: number;
  onGoToPage: (page: number) => void;
}) {
  const [inputValue, setInputValue] = useState('');
  const [popoverKey, setPopoverKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const confirm = (close?: () => void) => {
    const parsed = Number.parseInt(inputValue, 10);
    if (Number.isNaN(parsed)) return;
    const page = Math.min(Math.max(parsed, 1), Math.max(1, numPages));
    close?.();
    if (page !== currentPage) onGoToPage(page);
    setInputValue('');
    if (close) {
      setPopoverKey((key) => key + 1);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  return (
    <PopoverRoot key={popoverKey} className="relative">
      {({ close }) => (
        <>
          <Tooltip label="Go to page" side="top">
            <PopoverTrigger
              ref={triggerRef}
              className="h-6 whitespace-nowrap rounded-full px-2 text-xs tabular-nums"
              onClick={() => {
                setInputValue('');
                window.setTimeout(() => {
                  inputRef.current?.focus();
                  inputRef.current?.select();
                }, 50);
              }}
            >
              {currentPage} / {numPages}
            </PopoverTrigger>
          </Tooltip>
          <PopoverSurface anchor={{ to: 'top', gap: 8 }}>
            <div className="flex flex-col space-y-2">
              <div className="text-xs font-medium text-foreground">Go to page</div>
              <Input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                controlSize="sm"
                className="w-20 appearance-none border-none text-center text-accent"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => confirm()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirm(close);
                }}
                placeholder={currentPage.toString()}
                aria-label="Page number"
              />
              <div className="text-center text-xs text-soft">of {numPages}</div>
            </div>
          </PopoverSurface>
        </>
      )}
    </PopoverRoot>
  );
}

/** How far through the playback plan the current sentence is. */
export function ReadingProgress() {
  const { currentSentenceOrdinal, playbackPlanSegmentCount } = useTTS();
  if (!playbackPlanSegmentCount || currentSentenceOrdinal === null) return null;
  const percent = Math.round(((currentSentenceOrdinal + 1) / playbackPlanSegmentCount) * 100);
  return (
    <span className="whitespace-nowrap px-2 tabular-nums" aria-label={`Reading position ${percent}%`}>
      {percent}%
    </span>
  );
}
