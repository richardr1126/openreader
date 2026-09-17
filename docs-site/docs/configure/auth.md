---
title: Auth
---

This page covers application-level configuration for provider access and authentication.

## Auth behavior

- `BASE_URL` and `AUTH_SECRET` are required at startup.
- Keep `AUTH_TRUSTED_ORIGINS` empty to trust only `BASE_URL`.
- Anonymous auth sessions are disabled by default.
- Set `USE_ANONYMOUS_AUTH_SESSIONS=true` to enable anonymous session flows.

## Single sign-on (OAuth / OIDC)

Alongside email/password, two optional SSO methods are supported. Each appears on the sign-in page only when configured:

- **GitHub** — set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The OAuth callback URL to register with GitHub is `<BASE_URL>/api/auth/callback/github`.
- **Generic OIDC** — for self-hosted identity providers (Pocket ID, Authelia, Authentik, Keycloak, etc.). Set `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_DISCOVERY_URL` (the provider's `/.well-known/openid-configuration` URL). The callback URL to register with your provider is `<BASE_URL>/api/auth/callback/<OIDC_PROVIDER_ID>` (`oidc` unless you override `OIDC_PROVIDER_ID`). Optional: `OIDC_PROVIDER_NAME` labels the sign-in button (defaults to `SSO`), and `OIDC_SCOPES` overrides the requested scopes (defaults to `openid profile email`).

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

On a fresh installation, set a one-time first-admin credential before boot:

```env
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
```

OpenReader creates that account once. Sign in and change the initial password
under **Settings → Account**; the **Admin** tab appears after the password change.
If account email delivery is already enabled, the first sign-in attempt sends
a verification link. Follow it before signing in. No configuration edit or
restart is needed afterward. The initial password is invalid after the change;
removing the seed values later is optional. The email is not an admin allowlist,
and changing it later does not alter the role. Existing v4 admins are preserved
on upgrade. Additional admins are granted under **Settings → Admin → Users**.

Admins see dedicated areas for users, providers, account email, instance
settings, compute, and maintenance.

- **Shared TTS providers** — server-managed TTS provider instances with encrypted keys, visible to all users.
- **Site features** — runtime overrides for what were previously build-time public env flags (including account signup availability, default TTS provider, audiobook export, etc.).

## Email verification and password recovery

Account email is opt-in and disabled by default. An administrator configures it
under **Settings → Admin → Email** using a verified Resend sender and a
sending-only API key, sends a test, and then explicitly enables it.

When enabled:

- password registrations receive a one-hour verification link;
- password sign-in is blocked for existing and new unverified accounts and can
  resend a fresh verification link;
- **Forgot password?** sends a generic acknowledgement whether or not the
  address exists;
- reset links expire after one hour, successful resets revoke existing
  sessions, and the user signs in again;
- GitHub sign-in and already-active sessions keep their existing behavior.
- Registered users can request a new address in **Settings → Account**. The
  address changes only after the new inbox's verification link is followed.

When disabled, registration and password sign-in retain their previous
behavior; verification, email change, and recovery actions are clearly
unavailable. Users can still change a known password under **Settings → Account**.
Turning the feature off also prevents queued verification/reset messages from
being delivered.

Changing a password signs out other sessions. Admin role changes and signup
approval are managed in [Admin Panel](./admin-panel), not through email lists.

## Route behavior

- `/` is a public landing/onboarding page and remains indexable.
- `/app` is the protected app home (document list and uploader UI).
- If a valid session exists (including anonymous), visiting `/` redirects to `/app`.
- Protected app routes continue to require auth; when anonymous sessions are disabled and no session exists, users are redirected to `/signin`.
- `/verify-email`, `/forgot-password`, and `/reset-password` are public. Token-bearing pages send a `no-referrer` policy and are excluded from indexing.

## Related docs

- For auth environment variables: [Environment Variables](../reference/environment-variables#auth-and-identity)
- For admin role and shared TTS provider config: [Admin Panel](./admin-panel)
- For TTS character limits and quota behavior: [Compute Rate Limiting](./compute-rate-limiting)
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
