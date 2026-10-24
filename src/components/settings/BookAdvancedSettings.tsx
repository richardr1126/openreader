'use client';

import { useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { SaveBar, ToggleRow } from '@/components/ui';
import { EyeIcon } from '@/components/icons/Icons';
import { SpeechTextControls } from './SpeechTextControls';
import { PdfBlockKindControls } from './PdfBlockKindControls';
import { normalizeSpeechText, type SpeechTextOptions } from '@openreader/tts/speech-text';
import { VoiceCustomizationControls } from './VoiceCustomizationControls';
import { AdvancedSettings, AdvancedSettingsGroup } from './AdvancedSettings';
import { MaxSegmentLengthControl } from './MaxSegmentLengthControl';
import type { BookSpeechSettings } from '@/types/document-settings';
import { normalizeVoiceCustomization, VOICE_CUSTOMIZATION_FIELDS } from '@openreader/tts/voice-customization';

export function BookAdvancedSettings({ pdf }: { pdf?: { parsedOverlayEnabled: boolean; onToggleOverlay: (enabled: boolean) => void; parseStatus: string | null } }) {
  const { voiceCustomization: app, providerType, ttsSegmentMaxBlockLength, speechText, pdfSkipBlockKinds } = useConfig();
  const { bookSpeechSettings, setBookSpeechSettings } = useTTS();
  const saved = { voiceCustomization: bookSpeechSettings.voiceCustomization ?? {}, playback: bookSpeechSettings.playback ?? {} };
  const [draft, setDraft] = useState<Pick<BookSpeechSettings, 'voiceCustomization' | 'playback'> | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirmPlanChange, planChangeDialog } = usePlanChangeConfirm();
  const own = draft ?? saved;
  const ownVoice = own.voiceCustomization ?? {};
  const dirty = VOICE_CUSTOMIZATION_FIELDS.some(key => ownVoice[key] !== saved.voiceCustomization[key])
    || own.playback?.maxSegmentLength !== saved.playback.maxSegmentLength;
  const effective = normalizeVoiceCustomization({ ...app, ...ownVoice });
  const bookSpeechText = bookSpeechSettings.speechText ?? {};
  const changeSpeechText = (change: Partial<SpeechTextOptions>, reset?: keyof SpeechTextOptions) => {
    const next = { ...bookSpeechText, ...change };
    for (const key of ['citations', 'brackets'] as const) {
      if (key === reset || next[key] === speechText[key]) delete next[key];
    }
    confirmPlanChange({ setting: 'what is skipped when reading aloud', apply: () => { void setBookSpeechSettings({ speechText: next }); } });
  };

  const apply = async () => {
    setBusy(true);
    try {
      if (await setBookSpeechSettings(own)) setDraft(null);
    } finally { setBusy(false); }
  };
  return <AdvancedSettings><fieldset disabled={busy} className="min-w-0 space-y-5">
    <AdvancedSettingsGroup title="Skip when reading aloud" subtitle="This book uses app defaults until you change a control.">
      <SpeechTextControls value={normalizeSpeechText({ ...speechText, ...bookSpeechText })}
        overrides={bookSpeechText} onChange={changeSpeechText} onReset={key => changeSpeechText({}, key)} />
      {pdf && <PdfBlockKindControls value={bookSpeechSettings.pdf?.skipBlockKinds ?? pdfSkipBlockKinds}
        onChange={skipBlockKinds => confirmPlanChange({ setting: 'which PDF blocks are skipped',
          apply: () => { void setBookSpeechSettings({ pdf: { skipBlockKinds } }); } })}
        onReset={bookSpeechSettings.pdf?.skipBlockKinds !== undefined ? () => confirmPlanChange({ setting: 'which PDF blocks are skipped',
          apply: () => { void setBookSpeechSettings({ pdf: {} }); } }) : undefined}>
        <ToggleRow label="Show block overlay" icon={<EyeIcon />} checked={pdf.parsedOverlayEnabled}
          onChange={pdf.onToggleOverlay} disabled={pdf.parseStatus !== 'ready'} variant="plain" />
      </PdfBlockKindControls>}
    </AdvancedSettingsGroup>
    <VoiceCustomizationControls value={effective} local={providerType === 'kokoro-local'} overrides={ownVoice}
      onChange={change => {
        const next = { ...ownVoice, ...change };
        for (const key of VOICE_CUSTOMIZATION_FIELDS) if (next[key] === app[key]) delete next[key];
        setDraft({ ...own, voiceCustomization: next });
      }} onReset={key => { const next = { ...ownVoice }; delete next[key]; setDraft({ ...own, voiceCustomization: next }); }} />
    <MaxSegmentLengthControl value={own.playback?.maxSegmentLength ?? ttsSegmentMaxBlockLength}
      overridden={own.playback?.maxSegmentLength !== undefined}
      onChange={maxSegmentLength => setDraft({ ...own, playback: { maxSegmentLength } })}
      onReset={() => setDraft({ ...own, playback: {} })} />
    {(dirty || busy) && <SaveBar saving={busy} onDiscard={() => setDraft(null)}
      onSave={() => confirmPlanChange({ setting: 'advanced settings', apply: () => { void apply(); } })} />}
    {planChangeDialog}
  </fieldset></AdvancedSettings>;
}
