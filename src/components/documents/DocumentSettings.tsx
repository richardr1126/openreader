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

const viewTypeTextMapping = [
  { id: 'single', name: 'Single Page' },
  { id: 'dual', name: 'Two Pages' },
  { id: 'scroll', name: 'Continuous Scroll' },
];

const rangeInputClassName = 'w-full bg-offbase rounded-lg appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-lg [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent';

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
      <label className="block text-sm font-medium text-foreground">{label}</label>
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

type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

function ToggleRow({ label, description, checked, onChange, disabled = false }: ToggleRowProps) {
  return (
    <div className="rounded-xl border border-offbase bg-background px-3 py-2.5 shadow-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 form-checkbox h-4 w-4 text-accent rounded border-muted disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted">{description}</span>
        </span>
      </label>
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
      subtitle="Configure layout, preloading, and playback behavior for this document."
      bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,rgba(239,68,68,0.08),transparent_35%)]"
      panelClassName="w-full sm:w-[30rem]"
    >
      <div className="space-y-4">
        {!html && (
          <section className="rounded-2xl border border-offbase bg-base px-4 py-3 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Playback Flow</h3>
              <p className="text-xs text-muted mt-0.5">Control segment generation and lookahead while audio is active.</p>
            </div>

            <ToggleRow
              label="Skip blank pages"
              description="Automatically skip pages with no readable text."
              checked={skipBlank}
              onChange={(checked) => updateConfigKey('skipBlank', checked)}
            />

            <ToggleRow
              label="Smart sentence splitting"
              description="Merge sentence fragments across page or section boundaries."
              checked={smartSentenceSplitting}
              onChange={(checked) => updateConfigKey('smartSentenceSplitting', checked)}
            />

            <div className="rounded-xl border border-offbase bg-background px-3 py-3 space-y-3 shadow-sm">
              <RangeSetting
                label="Segment preload depth"
                value={localPreloadDepth}
                min={SEGMENT_PRELOAD_DEPTH_MIN}
                max={SEGMENT_PRELOAD_DEPTH_MAX}
                step={1}
                description="How many upcoming pages or locations to queue in the background."
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
                description="How many segments to ensure from each queued page or section."
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
                description="Maximum character count used when chunking text into segment blocks."
                valueWidth="w-14"
                formatter={(value) => String(value)}
                onChange={(value) => {
                  const next = clampTtsSegmentMaxBlockLength(value);
                  setLocalMaxBlockLength(next);
                  void updateConfigKey('ttsSegmentMaxBlockLength', next);
                }}
              />
            </div>
          </section>
        )}

        {!epub && !html && (
          <section className="rounded-2xl border border-offbase bg-base px-4 py-3 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">PDF Layout & Extraction</h3>
              <p className="text-xs text-muted mt-0.5">Set viewer mode and trim page edges before extraction.</p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">Page mode</label>
              <div
                role="radiogroup"
                aria-label="Page mode"
                className="grid grid-cols-3 gap-1 rounded-full border border-offbase bg-background p-1"
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
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        active
                          ? 'bg-accent text-background shadow-sm'
                          : 'text-muted hover:bg-base hover:text-foreground'
                      }`}
                    >
                      {view.name}
                    </button>
                  );
                })}
              </div>
              {selectedView.id === 'scroll' ? (
                <p className="text-xs text-warning">Continuous scroll may perform poorly for very large PDFs.</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-offbase bg-background px-3 py-3 shadow-sm">
              <p className="text-xs font-medium text-foreground">Text extraction margins</p>
              <p className="text-xs text-muted mt-0.5">
                Exclude content near edges before sentence extraction.
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
          </section>
        )}

        {!epub && !html && (
          <section className="rounded-2xl border border-offbase bg-base px-4 py-3 space-y-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">PDF Highlighting</h3>
              <p className="text-xs text-muted mt-0.5">Control playback highlighting behavior in PDF mode.</p>
            </div>
            <ToggleRow
              label="Highlight text during playback"
              description="Visual sentence-level playback highlighting in the PDF viewer."
              checked={pdfHighlightEnabled}
              onChange={(checked) => updateConfigKey('pdfHighlightEnabled', checked)}
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Use whisper.cpp timing data to highlight words as speech progresses${!canWordHighlight ? ' (disabled by configuration)' : ''}.`}
              checked={pdfWordHighlightEnabled && pdfHighlightEnabled}
              disabled={!pdfHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('pdfWordHighlightEnabled', checked)}
            />
          </section>
        )}

        {epub && (
          <section className="rounded-2xl border border-offbase bg-base px-4 py-3 space-y-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">EPUB Appearance</h3>
              <p className="text-xs text-muted mt-0.5">Apply app styling and playback highlighting in EPUB mode.</p>
            </div>
            <ToggleRow
              label="Apply app theme"
              description="Use selected theme on EPUB documents. May require refresh."
              checked={epubTheme}
              onChange={(checked) => updateConfigKey('epubTheme', checked)}
            />
            <ToggleRow
              label="Highlight text during playback"
              description="Visual sentence-level playback highlighting in the EPUB viewer."
              checked={epubHighlightEnabled}
              onChange={(checked) => updateConfigKey('epubHighlightEnabled', checked)}
            />
            <ToggleRow
              label="Word-by-word highlighting"
              description={`Use whisper.cpp timing data to highlight words as speech progresses${!canWordHighlight ? ' (disabled by configuration)' : ''}.`}
              checked={epubWordHighlightEnabled && epubHighlightEnabled}
              disabled={!epubHighlightEnabled || !canWordHighlight}
              onChange={(checked) => updateConfigKey('epubWordHighlightEnabled', checked)}
            />
          </section>
        )}
      </div>
    </ReaderSidebarShell>
  );
}
