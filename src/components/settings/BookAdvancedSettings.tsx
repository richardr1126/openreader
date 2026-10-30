'use client';

import { useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { SaveBar } from '@/components/ui';
import { VoiceCustomizationControls } from './VoiceCustomizationControls';
import { AdvancedSettings } from './AdvancedSettings';
import { MaxSegmentLengthControl } from './MaxSegmentLengthControl';
import type { BookSpeechSettings } from '@/types/document-settings';
import { normalizeVoiceCustomization, VOICE_CUSTOMIZATION_FIELDS } from '@openreader/tts/voice-customization';

export function BookAdvancedSettings() {
  const { voiceCustomization: app, providerType, ttsSegmentMaxBlockLength } = useConfig();
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

  const apply = async () => {
    setBusy(true);
    try {
      if (await setBookSpeechSettings(own)) setDraft(null);
    } finally { setBusy(false); }
  };
  return <AdvancedSettings><fieldset disabled={busy} className="min-w-0 space-y-5">
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
