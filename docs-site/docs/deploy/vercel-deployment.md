---
title: Vercel Deployment
---

This guide covers deploying OpenReader to Vercel with external Postgres and S3-compatible object storage.

## What works on Vercel

- Documents (PDF/EPUB/TXT/MD) work with `POSTGRES_URL` + external S3 storage.
- Audiobook export downloads the worker-owned playback MP3 stream; there are no audiobook-specific serverless routes.
- Heavy compute features (Whisper alignment + PDF layout parsing) run through an external compute worker service.
- For worker setup details and worker-specific env vars, see [Compute Worker (NATS JetStream)](./compute-worker).

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
# S3_INTERNAL_ENDPOINT=https://private-s3-endpoint.example
# S3_PUBLIC_ENDPOINT=https://s3.example
# S3_BROWSER_TRANSPORT=presigned
# S3_FORCE_PATH_STYLE=true

# Auth (required for the admin panel)
BASE_URL=https://your-app.vercel.app
AUTH_SECRET=...
ADMIN_EMAILS=you@example.com  # comma-separated; admins manage TTS + features in-app
CRON_SECRET=...               # generate with: openssl rand -base64 32

# Heavy compute (required on Vercel in current releases)
COMPUTE_WORKER_URL=https://<railway-worker-domain>
# Optional when browsers need a different public worker URL for playback audio
# COMPUTE_WORKER_PUBLIC_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=...
TTS_PLAYBACK_TOKEN_SECRET=... # generate with: openssl rand -base64 32; set the same value on the worker

# Logging (recommended for Vercel log ingestion)
LOG_FORMAT=json
LOG_LEVEL=info

# First-boot seed for the TTS shared provider (optional; manage in-app afterwards)
# API_KEY=your_replicate_key
# API_BASE only needed for OpenAI-compatible self-hosted providers
```

If you also run an external worker service (for example Railway), set these there too:

- `LOG_FORMAT=json`
- `COMPUTE_LOG_LEVEL=info`

:::note Env vars vs. admin panel (important for Vercel)
`API_KEY` / `API_BASE` are one-shot bootstrap seeds on first deploy. After boot, manage providers and site features in **Settings → Admin**. Changes there apply on refresh without a redeploy. See [Admin Panel](../configure/admin-panel).
:::

## 1a. Railway + Synadia quick start (worker mode)

If your Vercel app uses an external compute worker on Railway with Synadia Cloud (NGS):

1. Deploy a Railway service from:
   - `ghcr.io/richardr1126/openreader-compute-worker:refactor-ppdoclayoutv3-onnx-layout-parsing`
2. Enable public networking on that Railway service and set:
   - `COMPUTE_WORKER_URL=https://<railway-worker-domain>` (in Vercel)
   - `COMPUTE_WORKER_PUBLIC_URL=https://<railway-worker-domain>` (in Vercel) if browsers cannot reach `COMPUTE_WORKER_URL` directly
3. Use the same `COMPUTE_WORKER_TOKEN` value in both Vercel and Railway worker env vars.
4. Use the same `TTS_PLAYBACK_TOKEN_SECRET` value in both Vercel and Railway worker env vars.

For complete Railway worker env vars (`NATS_*`, `S3_*`, health checks, and Synadia `.creds` guidance), see [Compute Worker (NATS JetStream)](./compute-worker).

## 2. First-run admin configuration (recommended)

After the first successful deploy and admin login, open **Settings → Admin** and configure:

- **Shared providers**: create/edit your provider key(s) here (encrypted at rest).
- **Site features**:
  - `enableDocxConversion=false` on Vercel (`soffice` unavailable).
  - `enableTtsProvidersTab=false` if you want shared-provider-only UX.
  - `enableUserSignups=true` unless you explicitly want an invite-only deployment.
  - `defaultTtsProvider=replicate` (or your preferred shared slug).
  - `showAllProviderModels=false` if you want users locked to each provider's default model.
  - `enableAudiobookExport=true`.

## 3. Runtime JSON seed (optional)

If you must pre-seed site features/providers at deploy time, use `RUNTIME_SEED_JSON` or `RUNTIME_SEED_JSON_PATH` (versioned JSON seed document). Prefer the admin panel for ongoing management.

See [Environment Variables](../reference/environment-variables#runtime-json-seed-v4) for schema and examples.

:::warning Auth recommendation
Set both `BASE_URL` and `AUTH_SECRET` — they are required in v4+ and also required for the admin panel and for encrypting admin-stored TTS credentials.
:::

:::warning Rotating AUTH_SECRET invalidates admin-stored keys
Admin-managed TTS provider keys are encrypted with a key derived from `AUTH_SECRET`. If you rotate `AUTH_SECRET` after the first deploy, you must re-enter each admin shared provider's API key from the UI.
:::

:::tip
For all variables and defaults, see [Environment Variables](../reference/environment-variables).
:::

## 4. Database and data migrations

Vercel deployments do not run the `@openreader/bootstrap` process, so automatic startup migrations do not run there.

- Run `pnpm migrate` in a controlled environment to apply Drizzle schema migrations to your Postgres DB.
- Run `pnpm migrate-decommission` once during the v5 rollout to purge retired object prefixes (`tts_segments_v1/`, `tts_segments_v2/`, `audiobooks_v1/`).

## 5. Scheduled maintenance tasks

The repository configures `/api/admin/tasks/tick` as a Vercel Cron route. Set `CRON_SECRET`; requests without the matching bearer token are rejected.

The checked-in Hobby-compatible schedule invokes the route once daily. The admin task panel therefore prevents selecting intervals shorter than one day on Vercel, even though self-hosted deployments can run tasks more frequently.

Each due task is claimed with a database-backed lease, due tasks start independently, and individual runs are aborted and marked failed after four minutes. Review failures and run tasks manually from **Settings → Admin → Scheduled tasks**.

## 6. Runtime expectations and caveats

- Audiobook export requires the external compute worker and S3-compatible object storage because it downloads the worker-owned playback MP3 stream.
- For production Vercel deploys, use `POSTGRES_URL` instead of SQLite.

## 7. Smoke test after deploy

1. Upload and read a PDF/EPUB document.
2. Confirm sync/blob fetch works across refreshes/devices.
3. Start TTS playback and download an audiobook MP3 export.
4. Verify worker-backed word highlighting and PDF parsing.
5. Open **Settings → Admin → Scheduled tasks**, run one task manually, and confirm the next daily cron invocation succeeds.
