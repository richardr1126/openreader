import { createHash } from 'node:crypto';

export type TtsPlaybackSessionPurpose = 'live' | 'export-document';

export interface TtsPlaybackCanonicalScopeInput {
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  planObjectKey: string;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildTtsPlaybackCanonicalScopeKey(input: TtsPlaybackCanonicalScopeInput): string {
  return [
    'tts-playback-scope',
    'v1',
    input.storageUserId,
    input.documentId,
    String(Math.max(0, Math.floor(input.documentVersion))),
    input.readerType,
    input.settingsHash,
    input.planObjectKey,
  ].join('\0');
}

export function buildTtsPlaybackCanonicalSessionId(
  input: TtsPlaybackCanonicalScopeInput & { purpose: TtsPlaybackSessionPurpose },
): string {
  const scopeHash = stableHash(buildTtsPlaybackCanonicalScopeKey(input)).slice(0, 48);
  return `tts-${input.purpose}-${scopeHash}`;
}

export function buildTtsPlaybackExportArtifactId(
  input: TtsPlaybackCanonicalScopeInput & {
    format: 'mp3' | 'm4b';
    speed: number;
  },
): string {
  const speed = Math.max(0.5, Math.min(3, Number.isFinite(input.speed) ? input.speed : 1));
  return createHash('sha256')
    .update(buildTtsPlaybackCanonicalScopeKey(input))
    .update('\0')
    .update(input.format)
    .update('\0')
    .update(speed.toFixed(2))
    .digest('hex');
}
