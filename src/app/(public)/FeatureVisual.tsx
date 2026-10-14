import type { CSSProperties, ReactElement } from 'react';
import type { FEATURES } from './landing';

type FeatureKey = (typeof FEATURES)[number]['key'];

const vars = (values: Record<string, number | string>) => values as CSSProperties;

/** Layout analysis: blocks in a two-column page are boxed and numbered in reading order. */
function Formats() {
  const columns: { lines: number; head?: boolean; figure?: boolean }[][] = [
    [{ lines: 1, head: true }, { lines: 4 }],
    [{ lines: 3 }, { lines: 0, figure: true }],
  ];
  let order = 0;
  return (
    <div className="lu-vf-page">
      {columns.map((blocks, c) => (
        <div key={c} className="lu-vf-col">
          {blocks.map((block, b) => {
            const i = order++;
            return (
              <span
                key={b}
                className={`lu-vf-block${block.head ? ' lu-vf-head' : ''}${block.figure ? ' lu-vf-figure' : ''}`}
                style={vars({ '--i': i })}
              >
                {Array.from({ length: block.lines }, (_, l) => <i key={l} />)}
                <b>{i + 1}</b>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const ALIGN_WORDS = ['every', 'word', 'on', 'cue'];
const WAVE = [3, 6, 9, 5, 8, 4, 7, 10, 6, 3, 5, 9, 7, 4, 8, 6, 9, 5, 3, 7, 10, 6, 4, 8];

/** Forced alignment: a playhead crosses the waveform and each word lights on its timestamp. */
function Alignment() {
  return (
    <div className="lu-va">
      <p className="lu-va-words">
        {ALIGN_WORDS.map((word, i) => (
          <span key={word} style={vars({ '--i': i })}>{word}</span>
        ))}
      </p>
      <div className="lu-va-wave" style={vars({ '--n': WAVE.length })}>
        {WAVE.map((h, i) => <i key={i} style={vars({ '--h': h, '--i': i })} />)}
        <span className="lu-va-head" />
      </div>
    </div>
  );
}

const LANGUAGES = [
  ['EN', 'Read aloud'],
  ['ES', 'Leer en voz alta'],
  ['FR', 'Lire à voix haute'],
  ['DE', 'Vorlesen'],
  ['JA', '音読する'],
];

/** Language-aware narration: the same phrase rolls through languages. */
function Languages() {
  return (
    <div className="lu-vl" style={vars({ '--n': LANGUAGES.length })}>
      <div className="lu-vl-reel">
        {LANGUAGES.map(([code, phrase]) => (
          <p key={code}>
            <b>{code}</b>
            <span>{phrase}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** Audiobook export: chapters render one by one into a single file. */
function Export() {
  return (
    <div className="lu-ve">
      <div className="lu-ve-tracks">
        {['Ch 1', 'Ch 2', 'Ch 3', 'Ch 4'].map((label, i) => (
          <p key={label} style={vars({ '--i': i })}>
            <span>{label}</span>
            <i />
          </p>
        ))}
      </div>
      <span className="lu-ve-file">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        book.m4b
      </span>
    </div>
  );
}

/** Sync: the place you stop on one device is where the next one picks up. */
function Sync() {
  const lines = (
    <>
      <i />
      <i />
      <i />
      <i />
    </>
  );
  return (
    <div className="lu-vs">
      <span className="lu-vs-laptop">
        {lines}
        <em />
      </span>
      <svg className="lu-vs-arc" viewBox="0 0 100 40" preserveAspectRatio="none">
        <path d="M4 34 C 30 0, 70 0, 96 30" pathLength={1} />
      </svg>
      <span className="lu-vs-phone">
        {lines}
        <em />
      </span>
    </div>
  );
}

const LAYERS = ['Auth & accounts', 'Compute worker', 'SQLite or Postgres', 'S3 or SeaweedFS'];

/** The stack assembles layer by layer. */
function Stack() {
  return (
    <div className="lu-vk">
      {LAYERS.map((layer, i) => (
        <span key={layer} style={vars({ '--i': i })}>{layer}</span>
      ))}
    </div>
  );
}

const VISUALS: Record<FeatureKey, () => ReactElement> = {
  formats: Formats,
  alignment: Alignment,
  languages: Languages,
  export: Export,
  sync: Sync,
  stack: Stack,
};

/**
 * A small illustration at the top of each feature tile, scrubbed by scrolling:
 * in turn on the pinned desktop grid, or as each tile crosses the middle of a
 * narrow screen. Without scroll-driven animation support it shows the finished
 * state.
 */
export function FeatureVisual({ kind }: { kind: FeatureKey }) {
  const Visual = VISUALS[kind];
  return (
    <div className={`lu-viz lu-viz-${kind}`} aria-hidden="true">
      <Visual />
    </div>
  );
}
