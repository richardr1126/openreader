---
title: Admin Panel
---

The admin panel lets administrators manage users, shared TTS providers,
account email, site-wide feature flags, compute policy, and maintenance directly
from Settings without touching environment variables or redeploying.

It is gated behind authentication, so you must have auth enabled to use it ([Auth](./auth)).

## Designating admins

For a new instance, provide a one-time credential before first boot:

```env
AUTH_SECRET=...        # required for auth
BASE_URL=...           # required for auth
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
```

OpenReader creates the initial credential account once, without granting its
admin role yet. Sign in and change the initial password in **Settings → Account**
to activate the role. No configuration edit or restart is needed afterward;
removing the seed values later is optional secret hygiene. An existing
administrator is never replaced by the seed, and deleting the initial account
does not re-run it. `ADMIN_EMAILS` no longer grants access. Existing v4 admin
roles are preserved by the migration.

When the logged-in user is an admin, an **Admin** tab appears in **Settings → sidebar** with dedicated areas:

- **Shared providers** — server-side TTS provider instances visible to all users.
- **Users** — registered and anonymous accounts, status, usage, approval, role management, and deletion.
- **Site features** — runtime-editable replacements for what were previously build-time public env flags.
- **Email** — Resend delivery, sender identity, test delivery, verification, and password recovery.
- **Compute** — admission, usage, queue, and worker execution limits.
- **Maintenance** — scheduled cleanup and recent task status.

## Managing users

The **Users** area includes registered and anonymous accounts, email
verification, signup status, creation and last session activity, document
counts and owned bytes, and metered compute events. Search and filters are
server-side. Compute totals are not a full billing ledger; they reflect only
actions for which usage metering was enabled.

Admins can approve pending registrations, suspend or restore accounts, grant or
revoke admin access, and delete another user. Deletion first cleans up
user-owned storage; if cleanup fails, the account remains. The last active
administrator cannot be removed, and self-demotion, self-suspension, and
self-deletion are blocked. Role and access changes revoke affected sessions.

Approval is not email verification. If email ownership matters to your
deployment, enable account email delivery and check verification before
approval, or verify identity out of band. In **Site features**, set
`signupPolicy=approval` for approve-only registration, `open` for immediate
access, or `closed` to reject new registrations. Anonymous sessions are a
separate deployment opt-in.

## Account email through Resend

Account email is disabled by default. In **Admin → Email**:

1. Verify your sending domain in Resend.
2. Create a sending-only API key, preferably restricted to that domain.
3. Save the sender name, sender email, optional reply-to, and API key.
4. Send a test and wait for **Accepted by Resend**. This means the API accepted
   the request; it is not a claim that the message reached the inbox.
5. Enable account emails.

The saved key is encrypted with the same `AUTH_SECRET`-derived AES-256-GCM
helper used for other administrator-managed secrets. APIs return only whether a
key exists and its final four characters. Removing the key automatically
disables account email.

Next.js owns configuration and creates an encrypted, expiring delivery
envelope. NATS contains only that ciphertext plus nonsensitive delivery
identifiers. A dedicated worker consumer (concurrency one) resolves the current
Resend key through the credential-broker authentication boundary and calls
Resend over HTTPS. Verification and recovery messages stop when the feature is
disabled; administrator tests remain available before activation.

## Shared TTS providers

Each shared provider is one named instance bound to one of the four built-in provider types (`custom-openai`, `openai`, `replicate`, `deepinfra`). The admin form has:

| Field | Notes |
| --- | --- |
| **Slug** | URL-safe identifier exposed to users (e.g. `kokoro-prod`). Must not collide with a built-in id. Lowercase alphanumeric + hyphens. |
| **Display name** | Shown in the user's provider dropdown, suffixed with "(shared)". |
| **Provider type** | One of the four built-ins. Determines voice/model resolution. |
| **Base URL** | Optional. Falls through to the provider type's default when blank. |
| **API key** | Encrypted at rest with AES-256-GCM (key derived from `AUTH_SECRET` via scrypt). On edit, leave blank to keep the existing key. |
| **Default model** | Optional. Used as the initial model when a user selects this provider. |
| **Enabled** | Toggle to hide the provider from non-admin users without deleting it. |

When a non-admin user picks a provider in **Settings → TTS Provider**:

- The API key / base URL fields are hidden — those credentials never leave the server.
- The TTS request still goes through the user's browser, but the server replaces the slug with the matching admin row's decrypted key and base URL before calling the upstream provider.
- TTS credentials are resolved only from admin-managed shared providers and are never accepted from client request headers.

### Auto-seeded "default-openai"

On first boot, if `admin_providers` is empty and `API_BASE` or `API_KEY` is set, OpenReader creates a single shared provider with:

- slug `default-openai`, displayName `Default (from env)`, providerType `custom-openai`
- baseUrl from `API_BASE`, apiKey from `API_KEY` when provided (blank keys are supported)
- defaultModel from `API_MODEL_NAME`, falling back to `kokoro` when unset or blank

After this seed runs, the legacy `API_KEY` / `API_BASE` / `API_MODEL_NAME` env vars are no longer read by the TTS routes — the DB row is authoritative. You can rename, edit, disable, or delete this row like any other from the admin UI, and remove the env vars from your `.env` when convenient.

:::warning Upgrading from v2.2.0
In v2.2.0 and earlier, `API_KEY` / `API_BASE` were read live by the TTS routes on every request. As of v3.0.0 they are **one-shot seeds** consumed only on the first boot where `admin_providers` is empty. After upgrading, boot the app once and confirm a `default-openai` row exists in **Settings → Admin → Shared providers** with the correct base URL. If it is missing or wrong (e.g. the env vars were not set on first boot, or the table was already non-empty from a pre-release), create or edit the shared provider manually — TTS will not fall back to the env vars.
:::

## Site features

Runtime-editable settings, one row per key:

| Key | What it controls |
| --- | --- |
| `defaultTtsProvider` | Default provider id new users start with (built-in id or shared slug). |
| `changelogFeedUrl` | Public changelog manifest URL used by the Settings modal changelog panel. |
| `signupPolicy` | `open`, `approval`, or `closed`. Approval creates pending accounts that cannot sign in until approved under **Admin → Users**; closed refuses new accounts. |
| `enableTtsProvidersTab` | Whether the user-facing TTS Provider tab in Settings is shown. |
| `showAllProviderModels` | When `false`, users are restricted to each provider's default model (shared provider `defaultModel` or built-in provider default). |
| `enableAudiobookExport` | Show the audiobook export entry points on PDF/EPUB pages. |
| `enableDocxConversion` | Accept .docx uploads (converted to PDF server-side). |

Word-by-word highlighting and PDF layout parsing capability are controlled by compute-worker server env configuration, not an admin runtime flag.

Each row shows a source badge:

- **from seed** — the value was seeded on first boot (from `RUNTIME_SEED_JSON` / `RUNTIME_SEED_JSON_PATH`).
- **admin** — explicit admin override. Use **Reset** on the row to clear it back to built-in default behavior.
- **default** — no seed/admin row exists; built-in default is active.

## Rate limiting

A dedicated **Rate limiting** group controls the complete compute policy and the separate upload size cap:

| Key | What it controls |
| --- | --- |
| `computeLimitPolicies` | Versioned policy for all compute admission, usage, worker, resource, queue, and provider limits. |
| `maxUploadMb` | Maximum size (MB) accepted for a single document upload. Enforced server-side and signed into the presigned S3 PUT. |

Every compute action has a direct enabled switch and named controls for its start windows, active work, queue, and concurrency limits. Worker resource pools and provider throughput—including named provider overrides—are edited in the same form. TTS synthesis uses a soft per-segment threshold: cached segments are free, a segment admitted below the threshold finishes, and the next missing segment stops.

## TTS upstream

At the end of the **Site features** tab, a dedicated **TTS upstream** group controls server-side request and cache tuning (DB-backed runtime settings, not env vars):

| Key | What it controls |
| --- | --- |
| `ttsUpstreamMaxRetries` | Maximum retry attempts for upstream TTS 429/5xx responses. |
| `ttsUpstreamTimeoutMs` | Upstream request timeout for OpenAI-compatible TTS calls. |
| `ttsCacheMaxSizeBytes` | Maximum size of the in-memory TTS audio cache. |
| `ttsCacheTtlMs` | Time-to-live for cached TTS audio buffers. |

In v4 these settings are admin-only and are no longer configurable through environment variables.

## Scheduled tasks

The **Scheduled tasks** section controls background maintenance jobs such as expired-upload cleanup, orphaned-blob reaping, and rate-limit ledger pruning.

- Enable or disable each task, adjust its interval, or run it immediately.
- Runs use database-backed leases so multiple app instances do not normally execute the same task concurrently.
- A task that exceeds four minutes is aborted and recorded as failed. A crashed run can be reclaimed after its stale lease expires.
- Failures and the latest successful summary appear on the task card and in server logs.

Self-hosted Node.js deployments tick the scheduler in-process once per minute. Vercel uses the authenticated `/api/admin/tasks/tick` cron route; the checked-in Vercel Hobby schedule runs once daily, so intervals shorter than one day are unavailable there. See [Vercel Deployment](../deploy/vercel-deployment#5-scheduled-maintenance-tasks).

## Migrating off env vars

In v4, runtime site features, shared providers, and account email delivery are managed by admin settings and optional JSON seed. To minimize env surface area:

1. Deploy this version with your existing env values in place.
2. Boot the app once. Open Settings → Admin and verify:
   - Seeded settings appear as **from seed** (if you supplied a runtime JSON seed).
   - A `default-openai` row exists in **Shared providers** (if you had `API_BASE` or `API_KEY` set), with the `API_MODEL_NAME` value shown as its default model.
3. Remove any bootstrap env vars you no longer need from `.env`.
4. Redeploy. Behavior is unchanged — the DB is now the source of truth.

You can keep `API_BASE` / `API_KEY` / `API_MODEL_NAME` if you intentionally want bootstrap fallback behavior on empty provider tables.

## How keys are protected

- API keys are encrypted in the `admin_providers` table with AES-256-GCM. The encryption key is derived from `AUTH_SECRET` via `scrypt`.
- The masked-list view (`GET /api/admin/providers`, used by the admin UI itself) returns `••••` + last-4 only — never plaintext or ciphertext.
- The public list endpoint (`GET /api/tts/shared-providers`, called by every user's browser) returns only `{ slug, displayName, providerType, defaultModel }`. Keys and base URLs are never exposed to the client.
- Non-admin users cannot enumerate admin providers' credentials or base URLs through any API.

:::danger Rotating `AUTH_SECRET` invalidates all stored admin provider keys
Because the encryption key for `admin_providers` is derived from `AUTH_SECRET`, changing `AUTH_SECRET` makes every stored API key undecryptable. After rotating it, shared providers will fail to authenticate upstream until you re-enter each provider's API key in **Settings → Admin → Shared providers** (edit the row and paste the key again). There is no automated re-encryption path. If you must rotate `AUTH_SECRET`, plan to re-enter admin provider keys immediately afterward.
:::

## Related

- [Auth](./auth) — required to use the admin panel.
- [TTS Providers](./tts-providers) — shared-provider configuration and user-selectable behavior.
- [Environment Variables](../reference/environment-variables) — first-admin seed, provider bootstrap vars, and runtime JSON seed (including optional `accountEmail`).
