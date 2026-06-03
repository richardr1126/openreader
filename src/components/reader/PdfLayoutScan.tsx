'use client';

import { useEffect, useState } from 'react';
import styles from './PdfLayoutScan.module.css';

/**
 * PdfLayoutScan — ambient visualization of PP-DocLayout-V3 at work.
 *
 * A miniature document page sits directly on the loader's dotted background
 * while a scan beam sweeps across it. One layout region is "detected" at a time
 * — a box rendered with one
 * of a few simple shapes — while a readout chip above the page names its class.
 * It cycles through the complete set of region classes PP-DocLayout-V3 emits
 * (see PARSED_PDF_BLOCK_KINDS in types/parsed-pdf). Purely decorative; honours
 * prefers-reduced-motion by freezing on a single region. Styles live in the
 * adjacent CSS module so they stay out of the global stylesheet.
 *
 * When `failed` is set the animation is replaced by a static "halted" view —
 * the beam stops, the page dims, and an alert glyph sits on it — so the loader
 * never implies active work after a parse failure.
 */

// Only a handful of real shapes — most regions are just text lines.
type BlockShape = 'heading' | 'text' | 'small' | 'image' | 'table';

interface ScanBlock {
  label: string;
  shape: BlockShape;
}

// One consistent box size per shape, so every region renders the same way and
// nothing gets clipped — only the label changes.
const SHAPE_SIZE: Record<BlockShape, { width: number; height: number }> = {
  heading: { width: 82, height: 22 },
  text: { width: 88, height: 66 },
  small: { width: 72, height: 24 },
  image: { width: 80, height: 68 },
  table: { width: 88, height: 64 },
};

// Every PP-DocLayout-V3 class, in document-flow order, mapped to a simple shape.
const SCAN_BLOCKS: ScanBlock[] = [
  { label: 'Header', shape: 'small' },
  { label: 'Doc title', shape: 'heading' },
  { label: 'Abstract', shape: 'text' },
  { label: 'Paragraph title', shape: 'heading' },
  { label: 'Text', shape: 'text' },
  { label: 'Formula', shape: 'text' },
  { label: 'Formula number', shape: 'small' },
  { label: 'Figure title', shape: 'small' },
  { label: 'Image', shape: 'image' },
  { label: 'Chart', shape: 'image' },
  { label: 'Table', shape: 'table' },
  { label: 'Algorithm', shape: 'text' },
  { label: 'Content', shape: 'text' },
  { label: 'Aside text', shape: 'text' },
  { label: 'Number', shape: 'small' },
  { label: 'Reference', shape: 'small' },
  { label: 'Reference content', shape: 'text' },
  { label: 'Footnote', shape: 'small' },
  { label: 'Vision footnote', shape: 'small' },
  { label: 'Seal', shape: 'image' },
  { label: 'Footer', shape: 'small' },
];

const STEP_MS = 1050;

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(' ');

function BlockContent({ shape }: { shape: BlockShape }) {
  if (shape === 'image') {
    return (
      <svg className={styles.glyph} viewBox="0 0 48 32" fill="none" aria-hidden>
        <circle cx="13" cy="11" r="4" />
        <path d="M3 28l11-11 7 7 9-10 14 14z" />
      </svg>
    );
  }
  if (shape === 'table') {
    return (
      <div className={styles.table} aria-hidden>
        {Array.from({ length: 16 }).map((_, i) => (
          <span key={i} />
        ))}
      </div>
    );
  }
  const isHeading = shape === 'heading';
  const lines = isHeading ? 2 : shape === 'small' ? 2 : 5;
  return (
    <div className={cx(styles.lines, isHeading && styles.linesHeading)} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} style={i === lines - 1 ? { width: '58%' } : undefined} />
      ))}
    </div>
  );
}

export function PdfLayoutScan({ failed = false }: { failed?: boolean }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || failed) return; // no cycling once halted
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return; // freeze on the first region for reduced-motion users
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % SCAN_BLOCKS.length);
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [failed]);

  if (failed) {
    return (
      <div className={styles.stage} aria-hidden>
        <div className={styles.tagRow}>
          <span className={cx(styles.tag, styles.tagFailed)}>Parse halted</span>
        </div>

        <div className={cx(styles.page, styles.pageFailed)}>
          <svg className={styles.alert} viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 3.5 21 19H3L12 3.5Z"
              strokeLinejoin="round"
            />
            <path d="M12 10v4" strokeLinecap="round" />
            <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>

          <span className={cx(styles.corner, styles.cornerTl)} />
          <span className={cx(styles.corner, styles.cornerTr)} />
          <span className={cx(styles.corner, styles.cornerBl)} />
          <span className={cx(styles.corner, styles.cornerBr)} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.stage} aria-hidden>
      {/* readout chip: floats in the stage band above the page so long class
          names are never clipped by the page's rounded overflow */}
      <div className={styles.tagRow}>
        <span key={active} className={styles.tag}>
          {SCAN_BLOCKS[active].label}
        </span>
      </div>

      <div className={styles.page}>
        <div className={styles.solos}>
          {SCAN_BLOCKS.map((block, i) => {
            const size = SHAPE_SIZE[block.shape];
            return (
              <div
                key={i}
                className={cx(styles.solo, i === active && styles.active)}
                style={{ width: `${size.width}%`, height: `${size.height}%` }}
              >
                <BlockContent shape={block.shape} />
              </div>
            );
          })}
        </div>

        <div className={styles.beam} />
        <span className={cx(styles.corner, styles.cornerTl)} />
        <span className={cx(styles.corner, styles.cornerTr)} />
        <span className={cx(styles.corner, styles.cornerBl)} />
        <span className={cx(styles.corner, styles.cornerBr)} />
      </div>
    </div>
  );
}
