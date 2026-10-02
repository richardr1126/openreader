'use client';

import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useConfig, ViewType } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import {
  TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN,
  TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX,
  TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP,
  clampTtsSegmentMaxBlockLength,
} from '@/types/config';
import {
  IconButton,
  RangeField,
  Section,
  ToggleRow,
  CheckItem,
  SegmentedControl,
  Select,
} from '@/components/ui';
import { RefreshIcon } from '@/components/icons/Icons';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { Button } from '@/components/ui';
import type { ParsedPdfBlockKind, PdfParseStatus } from '@/types/parsed-pdf';
import { isForceReparseDisabled } from '@/lib/client/pdf/force-reparse';
import { getLanguageDisplayName, getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';

type ClearSegmentsPayload = {
  error?: string;
  deletedSegments?: number;
  requestedAudioObjects?: number;
  deletedAudioObjects?: number;
  deletedPlanObjects?: number;
  deletedPlaybackObjects?: number;
  invalidatedPlaybackSessions?: number;
  warning?: string;
};

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

const DOCUMENT_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Automatic (voice or metadata)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'hi', label: 'Hindi' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'ar', label: 'Arabic' },
  { value: 'th', label: 'Thai' },
];

export function DocumentSettings({ isOpen, setIsOpen, documentId, epub, html, language, detectedLanguage, onLanguageChange, pdf }: {
  isOpen: boolean,
  setIsOpen: (isOpen: boolean) => void,
  documentId?: string,
  epub?: boolean,
  html?: boolean,
  language?: string,
  detectedLanguage?: string | null,
  onLanguageChange?: (language: string) => void,
  pdf?: {
    parseStatus: PdfParseStatus | null;
    parsedOverlayEnabled: boolean;
    skipBlockKinds: ParsedPdfBlockKind[];
    onToggleOverlay: (enabled: boolean) => void;
    onToggleSkipKind: (kind: ParsedPdfBlockKind, enabled: boolean) => void;
    onForceReparse: () => void;
  }
}) {
  const {
    viewType,
    epubTheme,
    ttsSegmentMaxBlockLength,
    updateConfigKey,
    pdfHighlightEnabled,
    epubHighlightEnabled,
    pdfWordHighlightEnabled,
    epubWordHighlightEnabled,
    htmlHighlightEnabled,
    htmlWordHighlightEnabled,
    ttsModel,
  } = useConfig();
  const { voice, resolvedLanguage, reacquirePlaybackPlan, clearSegmentCaches } = useTTS();
  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    voice,
    documentLanguage: resolvedLanguage,
  });
  const selectedLanguage = DOCUMENT_LANGUAGE_OPTIONS.find((option) => option.value === language)
    ?? DOCUMENT_LANGUAGE_OPTIONS[0];
  const selectedView = viewTypeTextMapping.find(v => v.id === viewType) || viewTypeTextMapping[0];
  const isPdfMode = !epub && !html && !!pdf;
  const highlight = epub
    ? { sentence: epubHighlightEnabled, word: epubWordHighlightEnabled, sentenceKey: 'epubHighlightEnabled' as const, wordKey: 'epubWordHighlightEnabled' as const }
    : html
      ? { sentence: htmlHighlightEnabled, word: htmlWordHighlightEnabled, sentenceKey: 'htmlHighlightEnabled' as const, wordKey: 'htmlWordHighlightEnabled' as const }
      : { sentence: pdfHighlightEnabled, word: pdfWordHighlightEnabled, sentenceKey: 'pdfHighlightEnabled' as const, wordKey: 'pdfWordHighlightEnabled' as const };
  const [localMaxBlockLength, setLocalMaxBlockLength] = useState(ttsSegmentMaxBlockLength);
  const { confirmPlanChange, planChangeDialog } = usePlanChangeConfirm();

  // The slider only previews while dragging; the plan is rebuilt once on release.
  const commitMaxBlockLength = () => {
    if (localMaxBlockLength === ttsSegmentMaxBlockLength) return;
    confirmPlanChange({
      setting: 'the maximum segment length',
      apply: () => {
        void updateConfigKey('ttsSegmentMaxBlockLength', localMaxBlockLength)
          .then(reacquirePlaybackPlan);
      },
      onCancel: () => setLocalMaxBlockLength(ttsSegmentMaxBlockLength),
    });
  };

  useEffect(() => {
    setLocalMaxBlockLength(ttsSegmentMaxBlockLength);
  }, [ttsSegmentMaxBlockLength]);

  const clearSegmentsMutation = useMutation({
    mutationFn: async (): Promise<ClearSegmentsPayload | null> => {
      if (!documentId) throw new Error('Missing document id');
      const res = await fetch('/api/tts/segments/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await res.json().catch(() => null)) as ClearSegmentsPayload | null;
      if (!res.ok) {
        throw new Error(payload?.error || `Request failed (${res.status})`);
      }
      return payload;
    },
    onSuccess: (payload) => {
      // Drop the stale cached plan/segments so the next play rebuilds against the
      // freshly cleared storage instead of regenerating from a deleted plan.
      clearSegmentCaches();
      if (payload?.warning) {
        toast.error(`Audio cleared, but cleanup was partial: ${payload.warning}`);
      } else if (payload) {
        const deletedPlaybackObjects = Number(payload.deletedPlaybackObjects ?? payload.deletedAudioObjects ?? 0);
        const invalidatedPlaybackSessions = Number(payload.invalidatedPlaybackSessions ?? 0);
        const sessionSuffix = invalidatedPlaybackSessions > 0
          ? ` Reset ${invalidatedPlaybackSessions} playback session${invalidatedPlaybackSessions === 1 ? '' : 's'}.`
          : '';
        toast.success(`Cleared ${deletedPlaybackObjects} cached playback object${deletedPlaybackObjects === 1 ? '' : 's'}.${sessionSuffix}`);
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error && error.name === 'TimeoutError'
        ? 'Cleanup confirmation timed out. The cache may already be reset. Reload the reader before trying playback again.'
        : error instanceof Error ? error.message : 'Failed to clear cached audio');
    },
  });
  const { mutate: clearSegments, isPending: isClearingSegments } = clearSegmentsMutation;

  const handleClearCache = () => {
    if (!documentId || isClearingSegments) return;
    const confirmed = window.confirm('Clear all cached audio for this document? Playback will regenerate from scratch the next time you press play.');
    if (!confirmed) return;
    clearSegments();
  };

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="Document settings"
      title="Reader Settings"
      bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]"
      panelClassName="w-full sm:w-[30rem]"
    >
      <div className="space-y-5">
        {language && onLanguageChange ? (
          <Section title="Language" variant="group">
            <div className="space-y-1.5">
              <Select
                value={selectedLanguage}
                onChange={(option) => {
                  if (option.value === selectedLanguage.value) return;
                  confirmPlanChange({
                    setting: 'the document language',
                    apply: () => onLanguageChange(option.value),
                  });
                }}
                options={DOCUMENT_LANGUAGE_OPTIONS}
              />
              {language === 'auto' && detectedLanguage ? (
                <p className="text-xs text-soft">
                  Detected: {getLanguageDisplayName(detectedLanguage)}
                </p>
              ) : null}
              {languageWarnings.map((warning) => (
                <p key={warning} className="text-xs text-warning">
                  {warning}
                </p>
              ))}
            </div>
          </Section>
        ) : null}

        {isPdfMode || epub ? (
          <Section title="Display" variant="group">
            {isPdfMode ? (
              <div className="space-y-1.5">
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
            ) : null}
            {epub ? (
              <ToggleRow
                label="Use app theme"
                checked={epubTheme}
                onChange={(checked) => updateConfigKey('epubTheme', checked)}
                variant="plain"
              />
            ) : null}
          </Section>
        ) : null}

        <Section title="Highlighting" variant="group">
          <ToggleRow
            label="Highlight sentence"
            checked={highlight.sentence}
            onChange={(checked) => updateConfigKey(highlight.sentenceKey, checked)}
            variant="plain"
          />
          <ToggleRow
            label="Highlight words"
            checked={highlight.word && highlight.sentence}
            disabled={!highlight.sentence}
            onChange={(checked) => updateConfigKey(highlight.wordKey, checked)}
            variant="plain"
          />
        </Section>

        <Section title="Playback" variant="group">
          <RangeField
            label="Max segment length"
            value={localMaxBlockLength}
            min={TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN}
            max={TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX}
            step={TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP}
            valueWidth="w-14"
            onChange={(value) => setLocalMaxBlockLength(clampTtsSegmentMaxBlockLength(value))}
            onPointerUp={commitMaxBlockLength}
            onKeyUp={commitMaxBlockLength}
          />
          {documentId ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">Cached audio</span>
              <Button
                size="sm"
                onClick={handleClearCache}
                disabled={isClearingSegments}
              >
                {isClearingSegments ? 'Clearing…' : 'Clear cached audio'}
              </Button>
            </div>
          ) : null}
        </Section>

        {isPdfMode && pdf && (
          <Section
            title="PDF Layout"
            variant="group"
            action={
              <span className="flex items-center gap-1">
                <span>{pdf.parseStatus ?? 'pending'}</span>
                <IconButton
                  size="xs"
                  className="shrink-0"
                  onClick={pdf.onForceReparse}
                  disabled={isForceReparseDisabled(pdf.parseStatus)}
                  title="Force reparse"
                  aria-label="Force reparse"
                >
                  <RefreshIcon className={`h-3 w-3 ${isForceReparseDisabled(pdf.parseStatus) ? 'animate-spin' : ''}`} />
                </IconButton>
              </span>
            }
          >
            <ToggleRow
              label="Show block overlay"
              checked={pdf.parsedOverlayEnabled}
              onChange={pdf.onToggleOverlay}
              disabled={pdf.parseStatus !== 'ready'}
              variant="plain"
            />
            <details>
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                Skip when reading aloud
              </summary>
              <div className="grid grid-cols-2 gap-x-3 pt-2">
                {PDF_SKIP_KIND_OPTIONS.map((option) => (
                  <CheckItem
                    key={option.kind}
                    label={option.label}
                    checked={pdf.skipBlockKinds.includes(option.kind)}
                    onChange={(enabled) => confirmPlanChange({
                      setting: 'which PDF blocks are skipped',
                      apply: () => pdf.onToggleSkipKind(option.kind, enabled),
                    })}
                  />
                ))}
              </div>
            </details>
          </Section>
        )}
      </div>
      {planChangeDialog}
    </ReaderSidebarShell>
  );
}
