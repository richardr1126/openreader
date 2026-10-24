'use client';

import { ReaderAppearanceSettings } from '@/components/settings/ReaderAppearanceSettings';
import { BookAdvancedSettings } from '@/components/settings/BookAdvancedSettings';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import {
  IconButton,
  Section,
  Select,
} from '@/components/ui';
import {
  RefreshIcon,
} from '@/components/icons/Icons';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { DocumentStorageSection } from '@/components/documents/DocumentStorageSection';
import type { PdfParseStatus } from '@/types/parsed-pdf';
import { isForceReparseDisabled } from '@/lib/client/pdf/force-reparse';
import { getLanguageDisplayName, getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';

const DOCUMENT_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Automatic (voice or metadata)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'hi', label: 'Hindi' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'ar', label: 'Arabic' },
  { value: 'th', label: 'Thai' },
  { value: 'tr', label: 'Turkish' },
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
    onToggleOverlay: (enabled: boolean) => void;
    onForceReparse: () => void;
  }
}) {
  const {
    ttsModel,
    providerType,
  } = useConfig();
  const { voice } = useTTS();
  const { presentation } = useReaderAppearance();
  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    providerType,
    voice,
    configuredLanguage: language,
    documentLanguage: detectedLanguage,
  });
  const selectedLanguage = DOCUMENT_LANGUAGE_OPTIONS.find((option) => option.value === language)
    ?? DOCUMENT_LANGUAGE_OPTIONS[0];
  const isPdfMode = !epub && !html && !!pdf;
  const { confirmPlanChange, planChangeDialog } = usePlanChangeConfirm();

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

        <ReaderAppearanceSettings scope="book" showTypography={!isPdfMode || !presentation.showsLayout} />

        {isOpen && <BookAdvancedSettings key={documentId} pdf={isPdfMode ? pdf : undefined} />}

        {documentId ? <DocumentStorageSection documentId={documentId} /> : null}

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
            <p className="text-xs text-soft">Reparse this document to refresh detected PDF blocks.</p>
          </Section>
        )}
      </div>
      {planChangeDialog}
    </ReaderSidebarShell>
  );
}
