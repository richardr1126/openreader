---
title: Auth
---

This page covers application-level configuration for provider access and authentication.

## Auth behavior

- `BASE_URL` and `AUTH_SECRET` are required at startup in v4+.
- Keep `AUTH_TRUSTED_ORIGINS` empty to trust only `BASE_URL`.
- Anonymous auth sessions are disabled by default.
- Set `USE_ANONYMOUS_AUTH_SESSIONS=true` to enable anonymous session flows.

## Single sign-on (OAuth / OIDC)

Alongside email/password, two optional SSO methods are supported. Each appears on the sign-in page only when configured:

- **GitHub** — set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The OAuth callback URL to register with GitHub is `<BASE_URL>/api/auth/callback/github`.
- **Generic OIDC** — for self-hosted identity providers (Pocket ID, Authelia, Authentik, Keycloak, etc.). Set `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_DISCOVERY_URL` (the provider's `/.well-known/openid-configuration` URL). The callback URL to register with your provider is `<BASE_URL>/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>` (`oidc` unless you override `OIDC_PROVIDER_ID`). Optional: `OIDC_PROVIDER_NAME` labels the sign-in button (defaults to `SSO`), and `OIDC_SCOPES` overrides the requested scopes (defaults to `openid profile email`).

```env
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_DISCOVERY_URL=https://auth.example.com/.well-known/openid-configuration
OIDC_PROVIDER_NAME=Pocket ID
```

OIDC sign-ins are trusted for account linking: a user who originally signed up with email/password and later signs in through your identity provider with the same email address is attached to their existing account, keeping their documents and settings. OpenReader does not verify local email addresses. The IdP's email claim serves as ownership proof — only enable OIDC against an identity provider you operate and trust.

## Runtime modes

OpenReader has two common runtime modes:

- **Auth enabled, non-admin user**: user account/session features are available, but no admin controls.
- **Auth enabled, admin user**: full **Settings → Admin** access (shared providers + site features).

## Admin role

You can designate one or more users as admins via the `ADMIN_EMAILS` env var:

```env
ADMIN_EMAILS=alice@example.com,bob@example.com
```

Admins see a new **Admin** tab in **Settings** with two sub-tabs:

- **Shared TTS providers** — server-managed TTS provider instances with encrypted keys, visible to all users.
- **Site features** — runtime overrides for what were previously build-time public env flags (including account signup availability, default TTS provider, audiobook export, etc.).

Admin assignment is reconciled on every session resolution, so removing an email from `ADMIN_EMAILS` demotes the user on next login without a restart. See [Admin Panel](./admin-panel) for the full reference.

## Route behavior

- `/` is a public landing/onboarding page and remains indexable.
- `/app` is the protected app home (document list and uploader UI).
- If a valid session exists (including anonymous), visiting `/` redirects to `/app`.
- Protected app routes continue to require auth; when anonymous sessions are disabled and no session exists, users are redirected to `/signin`.

## Related docs

- For auth environment variables: [Environment Variables](../reference/environment-variables#auth-and-identity)
- For admin role and shared TTS provider config: [Admin Panel](./admin-panel)
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

## Claim modal note

- You may still see old anonymous settings/progress available to claim from older deployments.
- Legacy `unclaimed` data is only surfaced through the claim flow; normal authenticated routes are scoped to your current user id.
