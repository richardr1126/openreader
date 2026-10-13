'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  findActiveDemoWord,
  formatDemoTime,
  splitDemoSentence,
  type ActiveDemoWord,
  type ReaderDemo as ReaderDemoData,
} from './reader-demo-timeline';

const WAVE_BARS = 28;

/** `loading` covers the fetch before the first frame and any later stall. */
type DemoStatus = 'paused' | 'loading' | 'playing';

function sameWord(a: ActiveDemoWord | null, b: ActiveDemoWord | null): boolean {
  return a?.sentence === b?.sentence && a?.word === b?.word;
}

/**
 * The landing page's read-along sample: a static clip whose highlight follows
 * the audio clock exactly like the app's reader, with no session involved.
 */
export function ReaderDemo({ demo }: { demo: ReaderDemoData }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<DemoStatus>('paused');
  const running = status !== 'paused';
  const [active, setActive] = useState<ActiveDemoWord | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const sentences = useMemo(
    () => demo.sentences.map((sentence) => splitDemoSentence(sentence)),
    [demo.sentences],
  );

  // The audio element is the only clock; one frame loop projects it onto the
  // highlight while running and stops as soon as playback does.
  useEffect(() => {
    const audio = audioRef.current;
    if (!running || !audio) return;
    let frame = 0;
    const tick = () => {
      const next = findActiveDemoWord(demo.sentences, audio.currentTime);
      setActive((prev) => (sameWord(prev, next) ? prev : next));
      setElapsedSec(Math.floor(audio.currentTime));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, demo.sentences]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setStatus('paused'));
    } else {
      audio.pause();
    }
  };

  const reset = () => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = 0;
    setStatus('paused');
    setActive(null);
    setElapsedSec(0);
  };

  return (
    <aside className="public-reader public-reveal-2" aria-label="Read-along sample">
      <div className="public-reader-glow" aria-hidden="true" />
      <div className="public-reader-bar">
        <span className="public-reader-dot" data-tone="a" aria-hidden="true" />
        <span className="public-reader-dot" data-tone="b" aria-hidden="true" />
        <span className="public-reader-dot" data-tone="c" aria-hidden="true" />
        <span className="public-reader-file">{demo.fileName}</span>
        <span className="public-reader-voice">{demo.voiceLabel}</span>
      </div>

      <div className="public-reader-body">
        <p className="public-reader-chapter">{demo.chapter}</p>
        <p className="public-reader-text">
          {sentences.map((parts, s) => {
            const sentenceActive = active?.sentence === s;
            return (
              <span key={s}>
                {s > 0 ? ' ' : null}
                <span className={sentenceActive ? 'public-reader-sentence' : undefined}>
                  {parts.map((part, p) => (
                    <span
                      key={p}
                      className={
                        sentenceActive && part.word !== null && part.word === active.word
                          ? 'public-reader-word'
                          : undefined
                      }
                    >
                      {part.text}
                    </span>
                  ))}
                </span>
              </span>
            );
          })}
        </p>
      </div>

      <div className="public-player" data-status={status}>
        <button
          type="button"
          className="public-player-play"
          aria-label={running ? 'Pause sample' : 'Play sample'}
          aria-busy={status === 'loading'}
          onClick={toggle}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            {running ? (
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
            ) : (
              <path d="M8 5v14l11-7z" fill="currentColor" />
            )}
          </svg>
        </button>
        <div className="public-wave" aria-hidden="true">
          {Array.from({ length: WAVE_BARS }).map((_, i) => (
            <span key={i} className="public-wave-bar" style={{ '--b': i } as CSSProperties} />
          ))}
        </div>
        <span className="public-player-time">
          {formatDemoTime(elapsedSec)} / {formatDemoTime(demo.durationSec)}
        </span>
        <audio
          ref={audioRef}
          src={demo.audioSrc}
          preload="none"
          onPlay={() => setStatus('loading')}
          onPlaying={() => setStatus('playing')}
          onWaiting={() => setStatus('loading')}
          onPause={() => setStatus('paused')}
          onEnded={reset}
          onError={() => setStatus('paused')}
        />
      </div>
    </aside>
  );
}
