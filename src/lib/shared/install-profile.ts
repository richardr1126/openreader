/**
 * Read-only deployment fact that shapes presentation only. `desktop` is the
 * single-owner Electron install; every other deployment is `server`.
 *
 * It never grants, skips or relaxes authorization: `pnpm check:install-profile`
 * keeps it out of API routes, auth code and middleware.
 */
export type InstallProfile = 'server' | 'desktop';

/**
 * Where the compute worker runs, as the reader should hear it: `cloud` on
 * Vercel (the worker is a hosted service), `device` on desktop, `server` for
 * every other self-hosted deployment. Presentation only, like the profile.
 */
export type ComputeLocation = 'cloud' | 'server' | 'device';

/** "Preparing the model in the cloud" / "on the server" / "on this device". */
export function computeLocationPhrase(location: ComputeLocation): string {
  if (location === 'cloud') return 'in the cloud';
  if (location === 'device') return 'on this device';
  return 'on the server';
}
