---
title: Vercel Deployment
---

This guide covers deploying OpenReader to Vercel with external Postgres and S3-compatible object storage.

## What works on Vercel

- Documents (PDF/EPUB/TXT/MD) work with `POSTGRES_URL` + external S3 storage.
- Audiobook routes work on Node.js serverless functions using `ffmpeg-static`.

:::warning DOCX Conversion Limitation
`docx` conversion requires `soffice` (LibreOffice), which is not available in a standard Vercel runtime.
:::

## 1. Environment Variables

Recommended production setup (auth enabled, admin panel enabled):

```bash
# Infrastructure
POSTGRES_URL=postgres://...
USE_EMBEDDED_WEED_MINI=false
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
S3_REGION=us-east-1
S3_PREFIX=openreader
# Optional (non-AWS S3-compatible providers):
# S3_ENDPOINT=https://...
# S3_FORCE_PATH_STYLE=true

# Auth (required for the admin panel)
BASE_URL=https://your-app.vercel.app
AUTH_SECRET=...
ADMIN_EMAILS=you@example.com  # comma-separated; admins manage TTS + features in-app

# Heavy compute (recommended on Vercel in v1)
# local  = requires native binaries/models in-process
# none   = disable whisper alignment + PDF layout parsing
OPENREADER_COMPUTE_MODE=none

# First-boot seed for the TTS shared provider (optional; manage in-app afterwards)
API_KEY=your_replicate_key
# API_BASE only needed for OpenAI-compatible self-hosted providers
```

:::note Env vars vs. admin panel (important for Vercel)
`API_KEY` / `API_BASE` are one-shot bootstrap seeds on first deploy. After boot, manage providers and site features in **Settings → Admin**. Changes there apply on refresh without a redeploy. See [Admin Panel](../configure/admin-panel).
:::

## 2. First-run admin configuration (recommended)

After the first successful deploy and admin login, open **Settings → Admin** and configure:

- **Shared providers**: create/edit your provider key(s) here (encrypted at rest).
- **Site features**:
  - `enableDocxConversion=false` on Vercel (`soffice` unavailable).
  - `enableDestructiveDeleteActions=false` for safer public deployments.
  - `enableTtsProvidersTab=false` if you want shared-provider-only UX.
  - `enableUserSignups=true` unless you explicitly want an invite-only deployment.
  - `restrictUserApiKeys=true` to block user BYOK through the hosted server.
  - `defaultTtsProvider=replicate` (or your preferred shared slug).
  - `showAllProviderModels=false` if you want users locked to each provider's default model.
  - `enableAudiobookExport=true`.

## 3. Legacy first-boot seed (optional)

If you must pre-seed site features via environment variables, the legacy `NEXT_PUBLIC_*` seeds are still supported on first boot only. Prefer the admin panel for ongoing management.

See [Environment Variables](../reference/environment-variables#legacy-first-boot-runtime-seeds-optional) for the complete legacy seed list.

:::warning Auth recommendation
For internet-exposed Vercel deployments, set both `BASE_URL` and `AUTH_SECRET` — they are also required for the admin panel and for encrypting admin-stored TTS credentials. Running without auth is possible, but not recommended for public environments.
:::

:::warning Rotating AUTH_SECRET invalidates admin-stored keys
Admin-managed TTS provider keys are encrypted with a key derived from `AUTH_SECRET`. If you rotate `AUTH_SECRET` after the first deploy, you must re-enter each admin shared provider's API key from the UI.
:::

:::tip
For all variables and defaults, see [Environment Variables](../reference/environment-variables).
:::

## 4. Database and data migrations

Vercel deployments do not run `scripts/openreader-entrypoint.mjs`, so automatic startup migrations do not run there.

- Run `pnpm migrate` in a controlled environment to apply Drizzle schema migrations to your Postgres DB.
- Run `pnpm migrate-fs` only when migrating legacy local filesystem data (`docstore/documents_v1`, `docstore/audiobooks_v1`) into object storage + DB rows. Fresh Vercel deployments usually do not need this.

## 5. FFmpeg packaging in Vercel functions

`ffmpeg-static` binaries must be included in function traces. This repo already does that in `next.config.ts` via `outputFileTracingIncludes` for:

- `/api/audiobook`
- `/api/audiobook/chapter`
- `/api/audiobook/status`
- `/api/whisper`

:::info
`serverExternalPackages` should include `ffmpeg-static` so package paths resolve at runtime instead of being bundled into route output.
:::

If you change route paths or split handlers, update `outputFileTracingIncludes` accordingly.

## 6. Function memory sizing

FFmpeg workloads benefit from more memory/CPU. This repo includes:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "app/api/audiobook/route.ts": { "memory": 3009 },
    "app/api/whisper/route.ts": { "memory": 3009 }
  }
}
```

Adjust memory per route if your files are larger or your plan differs.

## 7. Runtime expectations and caveats

- Audiobook APIs require S3 configuration; otherwise they return `503`.
- For production Vercel deploys, use `POSTGRES_URL` instead of SQLite.

## 8. Smoke test after deploy

1. Upload and read a PDF/EPUB document.
2. Confirm sync/blob fetch works across refreshes/devices.
3. Generate at least one audiobook chapter and play/download it.
4. If you later enable compute locally (`OPENREADER_COMPUTE_MODE=local`), verify word highlighting timestamps on a TTS run.
