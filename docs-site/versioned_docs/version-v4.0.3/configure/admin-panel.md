---
title: Admin Panel
---

The admin panel lets a designated set of users manage **shared TTS providers** and **site-wide feature flags** directly from the Settings modal — without touching env vars or redeploying.

It is gated behind authentication, so you must have auth enabled to use it ([Auth](./auth)).

## Designating admins

Set `ADMIN_EMAILS` to a comma-separated list of emails:

```env
AUTH_SECRET=...        # required for auth
BASE_URL=...           # required for auth
ADMIN_EMAILS=alice@example.com,bob@example.com
```

On every session resolution the server compares the user's email against this list and writes `user.is_admin = true` (or `false` for emails removed from the list). No restart is required to demote — the next page load picks it up.

When the logged-in user is an admin, an **Admin** tab appears in **Settings → sidebar** with two sub-tabs:

- **Shared providers** — server-side TTS provider instances visible to all users.
- **Site features** — runtime-editable replacements for what were previously build-time public env flags.

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

When a non-admin user picks a shared provider in **Settings → TTS Provider**:

- The API key / base URL fields are hidden — those credentials never leave the server.
- The TTS request still goes through the user's browser, but the server replaces the slug with the matching admin row's decrypted key and base URL before calling the upstream provider.
- The user's per-request `x-openai-key` / `x-openai-base-url` headers are ignored for shared slugs.

Whether users can supply their own personal built-in provider keys is controlled by the site feature `restrictUserApiKeys`:

- `true`: users are restricted to shared providers only.
- `false`: users may also use per-user BYOK credentials for built-in providers.

### Auto-seeded "default-openai"

On first boot, if `admin_providers` is empty and the legacy `API_KEY` env var is set, OpenReader creates a single shared provider with:

- slug `default-openai`, displayName `Default (from env)`, providerType `custom-openai`
- baseUrl from `API_BASE`, apiKey from `API_KEY` (encrypted)
- defaultModel set to `kokoro` (you can edit it in Admin → Shared providers)

After this seed runs, the legacy `API_KEY` / `API_BASE` env vars are no longer read by the TTS routes — the DB row is authoritative. You can rename, edit, disable, or delete this row like any other from the admin UI, and remove the env vars from your `.env` when convenient.

:::warning Upgrading from v2.2.0
In v2.2.0 and earlier, `API_KEY` / `API_BASE` were read live by the TTS routes on every request. As of v3.0.0 they are **one-shot seeds** consumed only on the first boot where `admin_providers` is empty. After upgrading, boot the app once and confirm a `default-openai` row exists in **Settings → Admin → Shared providers** with the correct base URL. If it is missing or wrong (e.g. the env vars were not set on first boot, or the table was already non-empty from a pre-release), create or edit the shared provider manually — TTS will not fall back to the env vars.
:::

## Site features

Runtime-editable settings, one row per key:

| Key | What it controls |
| --- | --- |
| `defaultTtsProvider` | Default provider id new users start with (built-in id or shared slug). |
| `changelogFeedUrl` | Public changelog manifest URL used by the Settings modal changelog panel. |
| `enableUserSignups` | Controls whether new accounts can be created. Existing accounts can still sign in when this is `false`. |
| `restrictUserApiKeys` | Restrict user-supplied API keys/base URLs; when `true`, only admin shared providers are allowed. |
| `enableTtsProvidersTab` | Whether the user-facing TTS Provider tab in Settings is shown. |
| `showAllProviderModels` | When `false`, users are restricted to each provider's default model (shared provider `defaultModel` or built-in provider default). |
| `enableAudiobookExport` | Show the audiobook export entry points on PDF/EPUB pages. |
| `enableDocxConversion` | Accept .docx uploads (converted to PDF server-side). |

Word-by-word highlighting and PDF layout parsing capability are controlled by compute-worker server env configuration, not an admin runtime flag.

Each row shows a source badge:

- **from seed** — the value was seeded on first boot (from `RUNTIME_SEED_JSON` / `RUNTIME_SEED_JSON_PATH`).
- **admin** — explicit admin override. Use **Reset** on the row to clear it back to built-in default behavior.
- **default** — no seed/admin row exists; built-in default is active.

:::warning Security note for `restrictUserApiKeys`
Turning `restrictUserApiKeys` off allows user-supplied API keys to flow through this server. Use this only for trusted/self-hosted deployments where that tradeoff is acceptable.
:::

## Rate limiting

A dedicated **Rate limiting** group (within the same admin panel) collects the daily quotas, the PDF parsing throttle, and the upload size cap:

| Key | What it controls |
| --- | --- |
| `disableTtsRateLimit` | Disable the per-user/IP daily TTS character limits. When `false`, the daily-limit fields below it apply. |
| `disableComputeRateLimit` | Disable per-user PDF parsing rate limiting. When `false`, the burst/sustained limit fields below it apply. |
| `maxUploadMb` | Maximum size (MB) accepted for a single document upload. Enforced server-side and signed into the presigned S3 PUT. |

The **Disable TTS daily rate limiting** and **Disable PDF parsing rate limiting** toggles each reveal a collapsible group of numeric inputs when set to `false`:

- TTS: anonymous/authenticated per-user daily limits and anonymous/authenticated IP daily backstops.
- PDF parsing: burst limit + window (seconds) and sustained limit + window (seconds). The sustained window doubles as a concurrency cap.

## TTS upstream

At the end of the **Site features** tab, a dedicated **TTS upstream** group controls server-side request and cache tuning (DB-backed runtime settings, not env vars):

| Key | What it controls |
| --- | --- |
| `ttsUpstreamMaxRetries` | Maximum retry attempts for upstream TTS 429/5xx responses. |
| `ttsUpstreamTimeoutMs` | Upstream request timeout for OpenAI-compatible TTS calls. |
| `ttsCacheMaxSizeBytes` | Maximum size of the in-memory TTS audio cache. |
| `ttsCacheTtlMs` | Time-to-live for cached TTS audio buffers. |

In v4 these settings are admin-only and are no longer configurable through environment variables.

## Migrating off env vars

In v4, runtime site features are managed by admin settings and optional JSON seed. To minimize env surface area:

1. Deploy this version with your existing env values in place.
2. Boot the app once. Open Settings → Admin and verify:
   - Seeded settings appear as **from seed** (if you supplied a runtime JSON seed).
   - A `default-openai` row exists in **Shared providers** (if you had `API_KEY` set).
3. Remove any bootstrap env vars you no longer need from `.env`.
4. Redeploy. Behavior is unchanged — the DB is now the source of truth.

You can keep `API_BASE` / `API_KEY` if you intentionally want bootstrap fallback behavior on empty provider tables.

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
- [TTS Providers](./tts-providers) — built-in provider catalog and per-user behavior.
- [Environment Variables](../reference/environment-variables) — `ADMIN_EMAILS`, provider bootstrap vars, and runtime JSON seed.
