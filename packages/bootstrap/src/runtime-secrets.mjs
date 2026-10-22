import { createHmac } from 'node:crypto';

const PLAYBACK_SECRET_CONTEXT = 'openreader:tts-playback-token-secret:v1';

/**
 * Domain-separated playback secret for embedded mode, derived from AUTH_SECRET so
 * the app and its embedded worker share it without extra configuration.
 */
export function deriveEmbeddedPlaybackSecret(authSecret) {
  return createHmac('sha256', authSecret.trim())
    .update(PLAYBACK_SECRET_CONTEXT)
    .digest('base64url');
}

/**
 * Fills TTS_PLAYBACK_TOKEN_SECRET for an embedded worker when the operator did not
 * set one. An explicit value always wins.
 * Returns true when a value was derived.
 */
export function applyEmbeddedPlaybackSecret(env) {
  if (env.TTS_PLAYBACK_TOKEN_SECRET?.trim()) return false;
  const authSecret = env.AUTH_SECRET?.trim();
  if (!authSecret) return false;
  env.TTS_PLAYBACK_TOKEN_SECRET = deriveEmbeddedPlaybackSecret(authSecret);
  return true;
}

// Settings that belong to the Next.js app alone; no embedded service (worker,
// NATS, SeaweedFS) receives them. AUTH_SECRET signs sessions and encrypts
// provider credentials, and the playback secret is derived from it above before
// any child starts. Workers never reach the application database. The desktop
// launch token is the shell-to-app boundary.
const APP_ONLY_ENV = ['AUTH_SECRET', 'POSTGRES_URL', 'SQLITE_DB_PATH', 'DESKTOP_LAUNCH_TOKEN'];

/** Environment for an embedded child service, without app-only settings. */
export function embeddedServiceEnv(env, overrides = {}) {
  const serviceEnv = { ...env, ...overrides };
  for (const name of APP_ONLY_ENV) delete serviceEnv[name];
  return serviceEnv;
}
