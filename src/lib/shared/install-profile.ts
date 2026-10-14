/**
 * Read-only deployment fact that shapes presentation only. `desktop` is the
 * single-owner Electron install; every other deployment is `server`.
 *
 * It never grants, skips or relaxes authorization: `pnpm check:install-profile`
 * keeps it out of API routes, auth code and middleware.
 */
export type InstallProfile = 'server' | 'desktop';
