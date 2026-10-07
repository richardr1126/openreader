import { buildKokoroVoiceString, parseKokoroVoiceNames } from '@openreader/tts/kokoro';
import {
  getKokoroVoiceLanguages,
  getLanguageDisplayName,
  keepKokoroVoicesInOneLanguage,
} from '@openreader/tts/language';

/** Voice settings that regenerate audio; edited as a draft, applied once. */
export interface VoiceSettingsDraft {
  voice: string;
  nativeSpeed: number;
}

export interface VoicePickPolicy {
  /** More than one voice may be mixed (Kokoro on a multi-voice provider). */
  multi: boolean;
  maxVoices: number;
}

export function formatModelSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}

/** Voices the picker shows as selected for a stored voice string. */
export function selectedVoicesFor(voice: string, availableVoices: string[], policy: VoicePickPolicy): string[] {
  if (!policy.multi) return voice ? [voice] : availableVoices.slice(0, 1);
  let initial: string[] = [];
  if (voice.includes('+')) initial = parseKokoroVoiceNames(voice);
  else if (voice) initial = [voice];
  else if (availableVoices.length > 0) initial = [availableVoices[0]];
  return keepKokoroVoicesInOneLanguage(initial.slice(0, policy.maxVoices));
}

/**
 * Toggles one voice in the draft selection. Single-voice providers replace
 * the voice. Kokoro mixes keep one language (the newest pick wins) and drop
 * the oldest pick past `maxVoices`. The last voice cannot be removed.
 */
export function toggleDraftVoice(selected: string[], voiceId: string, policy: VoicePickPolicy): string[] {
  if (!policy.multi) return [voiceId];
  if (selected.includes(voiceId)) {
    return selected.length > 1 ? selected.filter((id) => id !== voiceId) : selected;
  }
  const next = keepKokoroVoicesInOneLanguage([...selected, voiceId], voiceId);
  if (next.length <= policy.maxVoices) return next;
  const compatiblePrevious = selected.filter((id) => next.includes(id));
  return [...compatiblePrevious.slice(-(policy.maxVoices - 1)), voiceId];
}

export function voiceStringFor(selected: string[], policy: VoicePickPolicy): string {
  return policy.multi ? buildKokoroVoiceString(selected) : selected[0] ?? '';
}

/** Human-readable voice name for labels: `af_heart + af_bella` for a mix. */
export function displayVoiceName(voice: string): string {
  return voice.includes('+') ? parseKokoroVoiceNames(voice).join(' + ') : voice;
}

/** The dock label, e.g. `af_heart · 1.1x`; speed only when supported and not 1. */
export function formatVoiceDockLabel(input: {
  voice: string;
  nativeSpeed: number;
  supportsNativeModelSpeed: boolean;
}): string {
  const name = displayVoiceName(input.voice) || 'Voice';
  return input.supportsNativeModelSpeed && input.nativeSpeed !== 1
    ? `${name} · ${formatModelSpeed(input.nativeSpeed)}`
    : name;
}

/** One line per pending change, e.g. `Voice af_heart → af_bella`. */
export function describePendingVoiceChanges(
  applied: VoiceSettingsDraft,
  draft: VoiceSettingsDraft,
): string[] {
  const changes: string[] = [];
  if (draft.voice !== applied.voice) {
    changes.push(`Voice ${displayVoiceName(applied.voice)} → ${displayVoiceName(draft.voice)}`);
  }
  if (draft.nativeSpeed !== applied.nativeSpeed) {
    changes.push(`Speed ${formatModelSpeed(applied.nativeSpeed)} → ${formatModelSpeed(draft.nativeSpeed)}`);
  }
  return changes;
}

/** The subset of a draft that differs from what is applied, or null when equal. */
export function pendingVoiceSettings(
  applied: VoiceSettingsDraft,
  draft: VoiceSettingsDraft,
): Partial<VoiceSettingsDraft> | null {
  const pending: Partial<VoiceSettingsDraft> = {};
  if (draft.voice !== applied.voice) pending.voice = draft.voice;
  if (draft.nativeSpeed !== applied.nativeSpeed) pending.nativeSpeed = draft.nativeSpeed;
  return Object.keys(pending).length > 0 ? pending : null;
}

export interface VoiceGroup {
  key: string;
  label: string;
  voices: string[];
}

/**
 * Filters voices by a search query and groups Kokoro voices by the language
 * their name prefix encodes. Other providers' voices form one group.
 */
export function groupVoices(voices: string[], query: string, groupByLanguage: boolean): VoiceGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? voices.filter((voiceId) => {
      if (voiceId.toLowerCase().includes(needle)) return true;
      const language = groupByLanguage ? getKokoroVoiceLanguages(voiceId)[0] : undefined;
      return Boolean(language) && getLanguageDisplayName(language as string).toLowerCase().includes(needle);
    })
    : voices;
  if (!groupByLanguage) return matches.length > 0 ? [{ key: 'all', label: 'Voices', voices: matches }] : [];

  const groups = new Map<string, VoiceGroup>();
  for (const voiceId of matches) {
    const language = getKokoroVoiceLanguages(voiceId)[0] ?? 'other';
    const group = groups.get(language) ?? {
      key: language,
      label: language === 'other' ? 'Other' : getLanguageDisplayName(language),
      voices: [],
    };
    group.voices.push(voiceId);
    groups.set(language, group);
  }
  return [...groups.values()];
}
