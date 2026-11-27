'use client';

import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { Section } from '@/components/ui';
import { normalizeSpeechText, type SpeechTextOptions } from '@openreader/tts/speech-text';
import { SpeechTextControls } from './SpeechTextControls';
import { PdfBlockKindControls } from './PdfBlockKindControls';

/**
 * What this book leaves out of speech. Each change rebuilds the narration
 * plan, so it applies after the regenerate confirmation rather than a draft.
 */
export function BookSkipSettings({ pdf }: { pdf: boolean }) {
  const { speechText, pdfSkipBlockKinds } = useConfig();
  const { bookSpeechSettings, setBookSpeechSettings, playbackPlanPayload } = useTTS();
  const { confirmPlanChange, planChangeDialog } = usePlanChangeConfirm();
  const bookSpeechText = bookSpeechSettings.speechText ?? {};
  const changeSpeechText = (change: Partial<SpeechTextOptions>, reset?: keyof SpeechTextOptions) => {
    const next = { ...bookSpeechText, ...change };
    for (const key of ['citations', 'brackets'] as const) {
      if (key === reset || next[key] === speechText[key]) delete next[key];
    }
    confirmPlanChange({ setting: 'what is skipped when reading aloud', apply: () => { void setBookSpeechSettings({ speechText: next }); } });
  };
  const changeBlockKinds = (blocks: typeof bookSpeechSettings.pdf) => confirmPlanChange({
    setting: 'which PDF blocks are skipped', apply: () => { void setBookSpeechSettings({ pdf: blocks }); },
  });

  return <Section title="Skip when reading aloud" variant="group">
    <SpeechTextControls value={normalizeSpeechText({ ...speechText, ...bookSpeechText })}
      overrides={bookSpeechText} onChange={changeSpeechText} onReset={key => changeSpeechText({}, key)} />
    {/* The server picks a PDF's default from when it was added, so show what its plan uses. */}
    {pdf && <PdfBlockKindControls value={bookSpeechSettings.pdf?.skipBlockKinds ?? playbackPlanPayload?.planning?.skipBlockKinds ?? pdfSkipBlockKinds}
      onChange={skipBlockKinds => changeBlockKinds({ skipBlockKinds })}
      onReset={bookSpeechSettings.pdf?.skipBlockKinds !== undefined ? () => changeBlockKinds({}) : undefined} />}
    {planChangeDialog}
  </Section>;
}
