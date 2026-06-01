'use client';

import { useState, useEffect } from 'react';
import { useConfig, ViewType } from '@/contexts/ConfigContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import {
  SEGMENT_PRELOAD_DEPTH_MIN,
  SEGMENT_PRELOAD_DEPTH_MAX,
  SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MIN,
  SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MAX,
  TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN,
  TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX,
  TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP,
  clampSegmentPreloadDepth,
  clampSegmentPreloadSentenceLookahead,
  clampTtsSegmentMaxBlockLength,
} from '@/types/config';
import { IconButton, RangeInput, Section, ToggleRow, CheckItem, SegmentedControl } from '@/components/ui';
import { RefreshIcon, SparkleIcon } from '@/components/icons/Icons';
import type { ParsedPdfBlockKind, PdfParseStatus } from '@/types/parsed-pdf';
import { isForceReparseDisabled } from '@/lib/client/pdf/force-reparse';

const PDF_SKIP_KIND_OPTIONS: Array<{ kind: ParsedPdfBlockKind; label: string }> = [
  { kind: 'header', label: 'Header' },
  { kind: 'footer', label: 'Footer' },
  { kind: 'footnote', label: 'Footnote' },
  { kind: 'vision_footnote', label: 'Vision footnote' },
  { kind: 'figure_title', label: 'Figure title' },
  { kind: 'doc_title', label: 'Document title' },
  { kind: 'paragraph_title', label: 'Paragraph title' },
  { kind: 'abstract', label: 'Abstract' },
  { kind: 'algorithm', label: 'Algorithm' },
  { kind: 'aside_text', label: 'Aside text' },
  { kind: 'content', label: 'Content' },
  { kind: 'reference', label: 'Reference' },
  { kind: 'reference_content', label: 'Reference content' },
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' },
  { kind: 'formula', label: 'Formula' },
  { kind: 'formula_number', label: 'Formula number' },
  { kind: 'table', label: 'Table' },
  { kind: 'chart', label: 'Chart' },
  { kind: 'image', label: 'Image' },
  { kind: 'seal', label: 'Seal' },
];

const viewTypeTextMapping = [
  { id: 'single', name: 'Single Page' },
  { id: 'dual', name: 'Two Pages' },
  { id: 'scroll', name: 'Continuous Scroll' },
];

type RangeSettingProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  description: string;
  valueWidth?: string;
  formatter?: (value: number) => string;
  onChange: (value: number) => void;
};

function RangeSetting({
  label,
  value,
  min,
  max,
  step,
  description,
  valueWidth = 'w-10',
  formatter = (next) => String(next),
  onChange,
}: RangeSettingProps) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</label>
      <div className="flex items-center gap-3">
        <RangeInput
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="flex-1"
        />
        <span className={`${valueWidth} text-xs font-semibold text-right text-foreground`}>{formatter(value)}</span>
      </div>
      <p className="text-xs text-muted">{description}</p>
    </div>
  );
}

export function DocumentSettings({ isOpen, setIsOpen, epub, html, pdf }: {
  isOpen: boolean,
  setIsOpen: (isOpen: boolean) => void,
  epub?: boolean,
  html?: boolean,
  pdf?: {
    parseStatus: PdfParseStatus | null;
    parsedOverlayEnabled: boolean;
    skipBlockKinds: ParsedPdfBlockKind[];
    onToggleOverlay: (enabled: boolean) => void;
    onToggleSkipKind: (kind: ParsedPdfBlockKind, enabled: boolean) => void;
    onForceReparse: () => void;
  }
}) {
  const canWordHighlight = true;
  const {
    viewType,
    skipBlank,
    epubTheme,
    segmentPreloadDepthPages,
    segmentPreloadSentenceLookahead,
    ttsSegmentMaxBlockLength,
    updateConfigKey,
    pdfHighlightEnabled,
    epubHighlightEnabled,
    pdfWordHighlightEnabled,
    epubWordHighlightEnabled,
    htmlHighlightEnabled,
    htmlWordHighlightEnabled,
  } = useConfig();
  const selectedView = viewTypeTextMapping.find(v => v.id === viewType) || viewTypeTextMapping[0];
  const isPdfMode = !epub && !html && !!pdf;
  const [localPreloadDepth, setLocalPreloadDepth] = useState(segmentPreloadDepthPages);
  const [localSentenceLookahead, setLocalSentenceLookahead] = useState(segmentPreloadSentenceLookahead);
  const [localMaxBlockLength, setLocalMaxBlockLength] = useState(ttsSegmentMaxBlockLength);

  useEffect(() => {
    setLocalPreloadDepth(segmentPreloadDepthPages);
  }, [segmentPreloadDepthPages]);

  useEffect(() => {
    setLocalSentenceLookahead(segmentPreloadSentenceLookahead);
  }, [segmentPreloadSentenceLookahead]);

  useEffect(() => {
    setLocalMaxBlockLength(ttsSegmentMaxBlockLength);
  }, [ttsSegmentMaxBlockLength]);

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="Document settings"
      title="Reader Settings"
      subtitle="Tune layout, preloading, and playback."
      bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]"
      panelClassName="w-full sm:w-[30rem]"
    >
      <div className="space-y-4">
        {isPdfMode && pdf && (
          <Section
            title="PDF Essentials"
            subtitle="Critical parsing and playback controls."
            variant="flat"
          >
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted">Page mode</label>
              <SegmentedControl
                value={selectedView.id as ViewType}
                options={viewTypeTextMapping.map((view) => ({ value: view.id as ViewType, label: view.name }))}
                onChange={(nextViewType) => updateConfigKey('viewType', nextViewType)}
                ariaLabel="Page mode"
                className="grid-cols-3"
              />
              {selectedView.id === 'scroll' ? (
                <p className="text-xs text-warning">Scroll mode may be slower on large PDFs.</p>
              ) : null}
            </div>
            <ToggleRow
              label="Highlight text during playback"
              description="Highlight the current sentence in PDF."
              checked={pdfHighlightEnabled}
              onChange={(checked) => updateConfigKey('pdfHighlightEnabled', checked)}
              variant="flat"
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Highlight words using timing data${!canWordHighlight ? ' (not available on this server)' : ''}.`}
              checked={pdfWordHighlightEnabled && pdfHighlightEnabled}
              disabled={!pdfHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('pdfWordHighlightEnabled', checked)}
              variant="flat"
            />
          </Section>
        )}

        {isPdfMode && pdf && (
          <Section
            title="PDF Advanced"
            subtitle="Optional visual and structural tuning."
            variant="flat"
            action={
              <div className="flex flex-col items-end gap-1">
                <span className="flex items-center gap-1 text-muted">
                  <SparkleIcon className="h-3 w-3 text-accent" />
                  <span className="text-xs">PP-DocLayout-V3</span>
                </span>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <span>{pdf.parseStatus ?? 'pending'}</span>
                  <IconButton
                    size="xs"
                    className="shrink-0"
                    onClick={pdf.onForceReparse}
                    disabled={isForceReparseDisabled(pdf.parseStatus)}
                    title="Force reparse"
                  >
                    <RefreshIcon className={`h-3 w-3 ${isForceReparseDisabled(pdf.parseStatus) ? 'animate-spin' : ''}`} />
                  </IconButton>
                </span>
              </div>
            }
          >
            <ToggleRow
              label="Show block overlay"
              description="Render detected block boxes and labels on the page."
              checked={pdf.parsedOverlayEnabled}
              onChange={pdf.onToggleOverlay}
              disabled={pdf.parseStatus !== 'ready'}
              variant="flat"
            />
            <details className="rounded-md border border-offbase bg-surface-solid px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted">
                Skip Block Kinds While Reading Aloud
              </summary>
              <div className="grid grid-cols-2 gap-x-3 pt-2">
                {PDF_SKIP_KIND_OPTIONS.map((option) => (
                  <CheckItem
                    key={option.kind}
                    label={option.label}
                    checked={pdf.skipBlockKinds.includes(option.kind)}
                    onChange={(enabled) => pdf.onToggleSkipKind(option.kind, enabled)}
                  />
                ))}
              </div>
            </details>
          </Section>
        )}

        <Section
          title="Playback Flow"
          subtitle="Segment and queue behavior."
          variant="flat"
        >
          {!html && (
            <ToggleRow
              label="Skip blank pages"
              description="Skip pages with no readable text."
              checked={skipBlank}
              onChange={(checked) => updateConfigKey('skipBlank', checked)}
              variant="flat"
            />
          )}


          <div className="space-y-3 pt-1">
            <RangeSetting
              label="Segment preload depth"
              value={localPreloadDepth}
              min={SEGMENT_PRELOAD_DEPTH_MIN}
              max={SEGMENT_PRELOAD_DEPTH_MAX}
              step={1}
              description="Upcoming pages/locations to queue."
              formatter={(value) => String(value)}
              onChange={(value) => {
                const next = clampSegmentPreloadDepth(value);
                setLocalPreloadDepth(next);
                void updateConfigKey('segmentPreloadDepthPages', next);
              }}
            />

            <RangeSetting
              label="Segment lookahead per page/location"
              value={localSentenceLookahead}
              min={SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MIN}
              max={SEGMENT_PRELOAD_SENTENCE_LOOKAHEAD_MAX}
              step={1}
              description="Segments to prepare per queued page/section."
              formatter={(value) => String(value)}
              onChange={(value) => {
                const next = clampSegmentPreloadSentenceLookahead(value);
                setLocalSentenceLookahead(next);
                void updateConfigKey('segmentPreloadSentenceLookahead', next);
              }}
            />

            <RangeSetting
              label="TTS segment max block length"
              value={localMaxBlockLength}
              min={TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN}
              max={TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX}
              step={TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP}
              description="Max characters per TTS segment block."
              valueWidth="w-14"
              formatter={(value) => String(value)}
              onChange={(value) => {
                const next = clampTtsSegmentMaxBlockLength(value);
                setLocalMaxBlockLength(next);
                void updateConfigKey('ttsSegmentMaxBlockLength', next);
              }}
            />
          </div>
        </Section>

        {epub && (
          <Section
            title="EPUB Appearance"
            subtitle="Theme and highlighting in EPUB mode."
            variant="flat"
          >
            <ToggleRow
              label="Apply app theme"
              description="Apply the app theme to EPUB (refresh may be needed)."
              checked={epubTheme}
              onChange={(checked) => updateConfigKey('epubTheme', checked)}
              variant="flat"
            />
            <ToggleRow
              label="Highlight text during playback"
              description="Highlight the current sentence in EPUB."
              checked={epubHighlightEnabled}
              onChange={(checked) => updateConfigKey('epubHighlightEnabled', checked)}
              variant="flat"
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Highlight words using timing data${!canWordHighlight ? ' (not available on this server)' : ''}.`}
              checked={epubWordHighlightEnabled && epubHighlightEnabled}
              disabled={!epubHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('epubWordHighlightEnabled', checked)}
              variant="flat"
            />
          </Section>
        )}

        {html && (
          <Section
            title="Text & Markdown Highlighting"
            subtitle="Playback highlighting in text/markdown mode."
            variant="flat"
          >
            <ToggleRow
              label="Highlight text during playback"
              description="Highlight the current sentence in the rendered text."
              checked={htmlHighlightEnabled}
              onChange={(checked) => updateConfigKey('htmlHighlightEnabled', checked)}
              variant="flat"
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Highlight words using timing data${!canWordHighlight ? ' (not available on this server)' : ''}.`}
              checked={htmlWordHighlightEnabled && htmlHighlightEnabled}
              disabled={!htmlHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('htmlWordHighlightEnabled', checked)}
              variant="flat"
            />
          </Section>
        )}
      </div>
    </ReaderSidebarShell>
  );
}
