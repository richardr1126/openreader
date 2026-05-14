'use client';

import { useState, useEffect, type ChangeEvent } from 'react';
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
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { Section, ToggleRow, segmentedButtonClass, segmentedGroupClass } from '@/components/formPrimitives';

const viewTypeTextMapping = [
  { id: 'single', name: 'Single Page' },
  { id: 'dual', name: 'Two Pages' },
  { id: 'scroll', name: 'Continuous Scroll' },
];

const rangeInputClassName = 'w-full bg-offbase rounded-md appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-md [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-md [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent';

type MarginKey = 'header' | 'footer' | 'left' | 'right';

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
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className={`flex-1 ${rangeInputClassName}`}
        />
        <span className={`${valueWidth} text-xs font-semibold text-right text-foreground`}>{formatter(value)}</span>
      </div>
      <p className="text-xs text-muted">{description}</p>
    </div>
  );
}

export function DocumentSettings({ isOpen, setIsOpen, epub, html }: {
  isOpen: boolean,
  setIsOpen: (isOpen: boolean) => void,
  epub?: boolean,
  html?: boolean
}) {
  const canWordHighlight = useFeatureFlag('enableWordHighlight');
  const {
    viewType,
    skipBlank,
    epubTheme,
    smartSentenceSplitting,
    segmentPreloadDepthPages,
    segmentPreloadSentenceLookahead,
    ttsSegmentMaxBlockLength,
    headerMargin,
    footerMargin,
    leftMargin,
    rightMargin,
    updateConfigKey,
    pdfHighlightEnabled,
    epubHighlightEnabled,
    pdfWordHighlightEnabled,
    epubWordHighlightEnabled,
  } = useConfig();
  const [localMargins, setLocalMargins] = useState({
    header: headerMargin,
    footer: footerMargin,
    left: leftMargin,
    right: rightMargin
  });
  const selectedView = viewTypeTextMapping.find(v => v.id === viewType) || viewTypeTextMapping[0];
  const [localPreloadDepth, setLocalPreloadDepth] = useState(segmentPreloadDepthPages);
  const [localSentenceLookahead, setLocalSentenceLookahead] = useState(segmentPreloadSentenceLookahead);
  const [localMaxBlockLength, setLocalMaxBlockLength] = useState(ttsSegmentMaxBlockLength);
  const marginValues: Record<MarginKey, number> = {
    header: headerMargin,
    footer: footerMargin,
    left: leftMargin,
    right: rightMargin,
  };

  useEffect(() => {
    setLocalMargins({
      header: headerMargin,
      footer: footerMargin,
      left: leftMargin,
      right: rightMargin
    });
  }, [headerMargin, footerMargin, leftMargin, rightMargin]);

  useEffect(() => {
    setLocalPreloadDepth(segmentPreloadDepthPages);
  }, [segmentPreloadDepthPages]);

  useEffect(() => {
    setLocalSentenceLookahead(segmentPreloadSentenceLookahead);
  }, [segmentPreloadSentenceLookahead]);

  useEffect(() => {
    setLocalMaxBlockLength(ttsSegmentMaxBlockLength);
  }, [ttsSegmentMaxBlockLength]);

  // Handler for slider release
  const handleMarginChangeComplete = (margin: MarginKey) => () => {
    const value = localMargins[margin];
    const configKey = `${margin}Margin`;
    if (value !== marginValues[margin]) {
      updateConfigKey(configKey as 'headerMargin' | 'footerMargin' | 'leftMargin' | 'rightMargin', value);
    }
  };

  const handleMarginSliderChange = (margin: MarginKey) => (event: ChangeEvent<HTMLInputElement>) => {
    setLocalMargins((previous) => ({
      ...previous,
      [margin]: Number(event.target.value),
    }));
  };

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="Document settings"
      title="Reader Settings"
      subtitle="Tune layout, preloading, and playback."
      bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,rgba(239,68,68,0.08),transparent_35%)]"
      panelClassName="w-full sm:w-[30rem]"
    >
      <div className="space-y-4">
        {!html && (
          <Section
            title="Playback Flow"
            subtitle="Segment and queue behavior."
            variant="flat"
          >
            <ToggleRow
              label="Skip blank pages"
              description="Skip pages with no readable text."
              checked={skipBlank}
              onChange={(checked) => updateConfigKey('skipBlank', checked)}
              variant="flat"
            />

            <ToggleRow
              label="Smart sentence splitting"
              description="Merge fragments across pages/sections."
              checked={smartSentenceSplitting}
              onChange={(checked) => updateConfigKey('smartSentenceSplitting', checked)}
              variant="flat"
            />

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
        )}

        {!epub && !html && (
          <Section
            title="PDF Layout & Extraction"
            subtitle="Page mode and extraction bounds."
            variant="flat"
          >
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted">Page mode</label>
              <div
                role="radiogroup"
                aria-label="Page mode"
                className={`${segmentedGroupClass} grid-cols-3`}
              >
                {viewTypeTextMapping.map((view) => {
                  const active = selectedView.id === view.id;
                  return (
                    <button
                      key={view.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => updateConfigKey('viewType', view.id as ViewType)}
                      className={segmentedButtonClass(active)}
                    >
                      {view.name}
                    </button>
                  );
                })}
              </div>
              {selectedView.id === 'scroll' ? (
                <p className="text-xs text-warning">Scroll mode may be slower on large PDFs.</p>
              ) : null}
            </div>

            <div className="space-y-1.5 pt-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Text extraction margins</p>
              <p className="text-xs text-muted mt-0.5">
                Ignore edge content before extraction.
              </p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(['header', 'footer', 'left', 'right'] as MarginKey[]).map((margin) => (
                  <div key={margin} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="capitalize text-foreground">{margin}</span>
                      <span className="font-semibold text-foreground">{Math.round(localMargins[margin] * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="0.2"
                      step="0.01"
                      value={localMargins[margin]}
                      onChange={handleMarginSliderChange(margin)}
                      onMouseUp={handleMarginChangeComplete(margin)}
                      onKeyUp={handleMarginChangeComplete(margin)}
                      onTouchEnd={handleMarginChangeComplete(margin)}
                      className={rangeInputClassName}
                    />
                  </div>
                ))}
              </div>
            </div>
          </Section>
        )}

        {!epub && !html && (
          <Section
            title="PDF Highlighting"
            subtitle="Playback highlighting in PDF mode."
            variant="flat"
          >
            <ToggleRow
              label="Highlight text during playback"
              description="Highlight the current sentence in PDF."
              checked={pdfHighlightEnabled}
              onChange={(checked) => updateConfigKey('pdfHighlightEnabled', checked)}
              variant="flat"
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Highlight words using timing data${!canWordHighlight ? ' (disabled by config)' : ''}.`}
              checked={pdfWordHighlightEnabled && pdfHighlightEnabled}
              disabled={!pdfHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('pdfWordHighlightEnabled', checked)}
              variant="flat"
            />
          </Section>
        )}

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
              description={`Highlight words using timing data${!canWordHighlight ? ' (disabled by config)' : ''}.`}
              checked={epubWordHighlightEnabled && epubHighlightEnabled}
              disabled={!epubHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('epubWordHighlightEnabled', checked)}
              variant="flat"
            />
          </Section>
        )}
      </div>
    </ReaderSidebarShell>
  );
}
