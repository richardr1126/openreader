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
- **Site features** — runtime-editable replacements for what were previously `NEXT_PUBLIC_*` build-time flags.

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

## Site features

Runtime-editable settings, one row per key:

| Key | What it controls |
| --- | --- |
| `defaultTtsProvider` | Default provider id new users start with (built-in id or shared slug). |
| `restrictUserApiKeys` | Restrict user-supplied API keys/base URLs; when `true`, only admin shared providers are allowed. |
| `enableTtsProvidersTab` | Whether the user-facing TTS Provider tab in Settings is shown. |
| `showAllDeepInfraModels` | Show the full DeepInfra catalog vs. the Kokoro-only subset. |
| `showAllProviderModels` | When `false`, users are restricted to each provider's default model (shared provider `defaultModel` or built-in provider default). |
| `enableWordHighlight` | Enable whisper.cpp word-by-word highlighting during TTS playback. |
| `enableAudiobookExport` | Show the audiobook export entry points on PDF/EPUB pages. |
| `enableDocxConversion` | Accept .docx uploads (converted to PDF server-side). |
| `enableDestructiveDeleteActions` | Show "Delete all data" buttons in the Documents tab (auth-disabled mode). |

Each row shows a source badge:

- **from env** — the value was migrated from the corresponding `NEXT_PUBLIC_*` env var on first boot. Editing it in the UI flips the source to **admin**.
- **admin** — explicit admin override. Use **Reset** on the row to clear it back to the env-default state.
- **default** — neither env nor admin set; uses the built-in default.

:::warning Security note for `restrictUserApiKeys`
Turning `restrictUserApiKeys` off allows user-supplied API keys to flow through this server. Use this only for trusted/self-hosted deployments where that tradeoff is acceptable.
:::

## Migrating off env vars

The future-direction goal is to remove `NEXT_PUBLIC_*` / `API_KEY` / `API_BASE` from your `.env` entirely. To do that safely:

1. Deploy this version with your existing env values in place.
2. Boot the app once. Open Settings → Admin and verify:
   - Each `NEXT_PUBLIC_*` setting appears as **from env**.
   - A `default-openai` row exists in **Shared providers** (if you had `API_KEY` set).
3. Remove the env vars from your `.env`.
4. Redeploy. Behavior is unchanged — the DB is now the source of truth.

You can keep the env vars indefinitely if you prefer; they're only read on the first boot when the corresponding DB row is absent, so there's no harm in leaving them around.

## How keys are protected

- API keys are encrypted in the `admin_providers` table with AES-256-GCM. The encryption key is derived from `AUTH_SECRET` via `scrypt`. This means rotating `AUTH_SECRET` will invalidate all stored admin keys — re-enter them via the admin UI after rotating.
- The masked-list view (`GET /api/admin/providers`, used by the admin UI itself) returns `••••` + last-4 only — never plaintext or ciphertext.
- The public list endpoint (`GET /api/tts/shared-providers`, called by every user's browser) returns only `{ slug, displayName, providerType, defaultModel }`. Keys and base URLs are never exposed to the client.
- Non-admin users cannot enumerate admin providers' credentials or base URLs through any API.

## Related

- [Auth](./auth) — required to use the admin panel.
- [TTS Providers](./tts-providers) — built-in provider catalog and per-user behavior.
- [Environment Variables](../reference/environment-variables) — `ADMIN_EMAILS` and the legacy flags that the admin UI replaces.
