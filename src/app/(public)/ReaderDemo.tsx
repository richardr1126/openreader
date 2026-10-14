'use client';

import { useRef, type PointerEvent } from 'react';
import { formatDemoTime, type ReaderDemo as ReaderDemoData } from './reader-demo-timeline';
import { useReaderDemo } from './useReaderDemo';

/** Leans the window toward a fine pointer; touch and reduced motion stay flat. */
function tilt(event: PointerEvent<HTMLDivElement>) {
  if (event.pointerType !== 'mouse') return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;
  el.style.setProperty('--ry', `${(x * 5).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${(-y * 4).toFixed(2)}deg`);
  el.style.setProperty('--gx', `${((x + 0.5) * 100).toFixed(1)}%`);
  el.style.setProperty('--gy', `${((y + 0.5) * 100).toFixed(1)}%`);
}

function untilt(event: PointerEvent<HTMLDivElement>) {
  for (const prop of ['--rx', '--ry', '--gx', '--gy']) event.currentTarget.style.removeProperty(prop);
}

/**
 * The read-along sample: a floating glass window with a detached control
 * ornament. The frame loop in `useReaderDemo` writes `--progress` onto the
 * stage, which fills the ornament's ring without a React render per frame.
 */
export function ReaderDemo({ demo }: { demo: ReaderDemoData }) {
  const stageRef = useRef<HTMLElement>(null);
  const { audioRef, audioProps, status, running, active, elapsedSec, failed, sentences, toggle } =
    useReaderDemo(demo, stageRef);
  const spoken = active ? demo.sentences[active.sentence].words[active.word] : null;

  return (
    <aside ref={stageRef} className="lu-stage" data-status={status} aria-label="Read-along sample">
      <div className="lu-window lu-glass" onPointerMove={tilt} onPointerLeave={untilt}>
        <div className="lu-window-bar">
          <span className="lu-window-file">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M6 3h8l4 4v14H6zM14 3v4h4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            {demo.fileName}
          </span>
          <span className="lu-window-chapter">{demo.chapter}</span>
        </div>
        <p className="lu-window-text">
          {sentences.map((parts, s) => (
            <span key={s}>
              {s > 0 ? ' ' : null}
              <span className={active?.sentence === s ? 'openreader-html-highlight-sentence' : undefined}>
                {parts.map((part, p) => (
                  <span
                    key={p}
                    className={
                      active?.sentence === s && part.word !== null && part.word === active.word
                        ? 'openreader-html-highlight-word'
                        : undefined
                    }
                  >
                    {part.text}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </p>
      </div>
      {/* Annotations pinned to the live highlight with CSS anchor positioning. */}
      <span className="lu-wordtag" aria-hidden="true">
        {spoken ? `${spoken.startSec.toFixed(2)}s` : null}
      </span>
      <span className="lu-aside lu-aside-sentence lu-glass" aria-hidden="true">
        <b>Sentence</b>
        Tinted while it’s spoken
      </span>
      <span className="lu-aside lu-aside-word lu-glass" aria-hidden="true">
        <b>Word</b>
        Timed by forced alignment
      </span>
      <span className="lu-grabber" aria-hidden="true" />

      <div className="lu-ornament lu-glass">
        <button
          type="button"
          className="lu-play"
          aria-label={running ? 'Pause sample' : 'Play sample'}
          aria-busy={status === 'loading'}
          onClick={toggle}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {running ? (
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
            ) : (
              <path d="M8 5v14l11-7z" fill="currentColor" />
            )}
          </svg>
        </button>
        <div className="lu-ornament-meta">
          <span className="lu-ornament-state">
            {failed ? (
              <span role="alert">Sample unavailable</span>
            ) : status === 'loading' ? (
              'Preparing voice…'
            ) : running ? (
              'Reading aloud'
            ) : (
              'Listen to a real sample'
            )}
          </span>
          <span className="lu-ornament-voice">{demo.voiceLabel}</span>
        </div>
        <span className="lu-eq" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="lu-ornament-time">
          {formatDemoTime(elapsedSec)}
          <small> / {formatDemoTime(demo.durationSec)}</small>
        </span>
      </div>
      <audio ref={audioRef} {...audioProps} />
    </aside>
  );
}
