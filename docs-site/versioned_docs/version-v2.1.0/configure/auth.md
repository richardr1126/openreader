---
title: Auth
---

This page covers application-level configuration for provider access and authentication.

## Auth behavior

- Auth is enabled only when both `BASE_URL` and `AUTH_SECRET` are set.
- Remove either value to disable auth.
- Keep `AUTH_TRUSTED_ORIGINS` empty to trust only `BASE_URL`.
- Anonymous auth sessions are disabled by default.
- Set `USE_ANONYMOUS_AUTH_SESSIONS=true` to enable anonymous session flows.

## Route behavior

- `/` is a public landing/onboarding page and remains indexable.
- `/app` is the protected app home (document list and uploader UI).
- If auth is enabled and a valid session exists (including anonymous), visiting `/` redirects to `/app`.
- Protected app routes continue to require auth; when anonymous sessions are disabled and no session exists, users are redirected to `/signin`.

## Related docs

- For auth environment variables: [Environment Variables](../reference/environment-variables#auth-and-identity)
- For TTS character limits and quota behavior: [TTS Rate Limiting](./tts-rate-limiting)
- For provider-specific guidance: [TTS Providers](./tts-providers)
- For storage/S3/SeaweedFS behavior: [Object / Blob Storage](./object-blob-storage)
- For database mode: [Database](./database)
- For migration behavior and commands: [Migrations](./migrations)

## Sync notes

### Auth enabled

- Settings and reading progress are saved to the server.
- Updates are not instant push-based sync; they use normal client polling/refresh behavior.
- If two devices change the same item around the same time, the newest update wins.

### Auth disabled

- Settings and reading progress stay local in the browser (Dexie/IndexedDB).
- This avoids no-auth cross-browser conflicts, but there is no cross-device sync.

## Claim modal note

- You may still see old anonymous settings/progress available to claim from older deployments.
