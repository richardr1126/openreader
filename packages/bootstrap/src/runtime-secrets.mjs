import { createHmac } from 'node:crypto';

const PLAYBACK_SECRET_CONTEXT = 'openreader:tts-playback-token-secret:v1';

/**
 * Stable, domain-separated playback secret for embedded mode. The value also keys
 * the persisted segment content hash, so it must be identical on every boot; it is
 * derived from AUTH_SECRET, which deployments already keep stable.
 */
export function deriveEmbeddedPlaybackSecret(authSecret) {
  return createHmac('sha256', authSecret.trim())
    .update(PLAYBACK_SECRET_CONTEXT)
    .digest('base64url');
}

/**
 * Fills TTS_PLAYBACK_TOKEN_SECRET for an embedded worker when the operator did not
 * set one. An explicit value always wins so existing caches keep their identity.
 * Returns true when a value was derived.
 */
export function applyEmbeddedPlaybackSecret(env) {
  if (env.TTS_PLAYBACK_TOKEN_SECRET?.trim()) return false;
  const authSecret = env.AUTH_SECRET?.trim();
  if (!authSecret) return false;
  env.TTS_PLAYBACK_TOKEN_SECRET = deriveEmbeddedPlaybackSecret(authSecret);
  return true;
}
