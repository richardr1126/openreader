---
title: Vercel Deployment
---

This guide covers deploying the OpenReader app to Vercel with external Postgres, S3-compatible
object storage, NATS JetStream, and a standalone compute worker such as Railway.

## What works on Vercel

- Documents (PDF/EPUB/DOCX/TXT/MD) work with `POSTGRES_URL` + external S3 storage.
- Background TTS generation, playback, previews, DOCX conversion, Whisper alignment, PDF layout
  parsing, and audiobook export run through an external compute worker service.
- Audiobook export downloads the worker-owned playback stream; there are no audiobook-specific
  serverless routes.
- For worker setup details and worker-specific env vars, see [Compute Worker (NATS JetStream)](./compute-worker).

:::info DOCX conversion
The published compute-worker image includes headless LibreOffice. DOCX conversion therefore works
with Vercel when the external worker is configured; Vercel itself does not run `soffice`.
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
COMPUTE_CREDENTIAL_BROKER_TOKEN=... # generate separately; set the same value on the worker
TTS_PLAYBACK_TOKEN_SECRET=... # generate with: openssl rand -base64 32; set the same value on the worker

# Logging (recommended for Vercel log ingestion)
LOG_FORMAT=json
LOG_LEVEL=info

# First-boot seed for the TTS shared provider (optional; manage in-app afterwards)
# API_KEY=your_replicate_key
# API_BASE only needed for OpenAI-compatible self-hosted providers
```

If you also run an external worker service (for example Railway), configure it with:

- `COMPUTE_CREDENTIAL_BROKER_URL=https://<your-app-domain>/api/internal/compute/tts-credentials`
- the matching `COMPUTE_CREDENTIAL_BROKER_TOKEN`
- the matching `COMPUTE_WORKER_TOKEN` and `TTS_PLAYBACK_TOKEN_SECRET`
- its NATS connection and the same S3 storage configuration used by the app
- `LOG_FORMAT=json`
- `COMPUTE_LOG_LEVEL=info`

Do not set the app's `AUTH_SECRET` or `POSTGRES_URL` on the worker. Provider lookup and decryption remain app-owned.
Self-hosted provider URLs configured in the admin panel must be reachable from the worker runtime,
not from Vercel or the browser. A Railway worker cannot reach a provider through `localhost` or
`host.docker.internal` on your personal computer.

:::note Env vars vs. admin panel (important for Vercel)
`API_KEY` / `API_BASE` are one-shot bootstrap seeds on first deploy. After boot, manage providers and site features in **Settings → Admin**. Changes there apply on refresh without a redeploy. See [Admin Panel](../configure/admin-panel).
:::

## 1a. Railway + Synadia quick start (worker mode)

If your Vercel app uses an external compute worker on Railway with Synadia Cloud (NGS):

1. Deploy a Railway service from:
   - `ghcr.io/richardr1126/openreader-compute-worker:latest`
2. Enable public networking on that Railway service and set:
   - `COMPUTE_WORKER_URL=https://<railway-worker-domain>` (in Vercel)
   - `COMPUTE_WORKER_PUBLIC_URL=https://<railway-worker-domain>` (in Vercel) if browsers cannot reach `COMPUTE_WORKER_URL` directly
3. Use the same `COMPUTE_WORKER_TOKEN` value in both Vercel and Railway worker env vars.
4. Use the same `COMPUTE_CREDENTIAL_BROKER_TOKEN` value in both Vercel and Railway worker env vars, and point the worker broker URL at the Vercel app.
5. Use the same `TTS_PLAYBACK_TOKEN_SECRET` value in both Vercel and Railway worker env vars. The worker derives a domain-separated private-text fingerprint key from it; no additional text-hash secret is configured.

For complete Railway worker env vars (`NATS_*`, `S3_*`, health checks, and Synadia `.creds` guidance), see [Compute Worker (NATS JetStream)](./compute-worker).

## 2. First-run admin configuration (recommended)

After the first successful deploy and admin login, open **Settings → Admin** and configure:

- **Shared providers**: create/edit your provider key(s) here (encrypted at rest).
- **Site features**:
  - `enableDocxConversion=true` when the published compute-worker image is connected.
  - `enableTtsProvidersTab=false` if you want shared-provider-only UX.
  - `enableUserSignups=true` unless you explicitly want an invite-only deployment.
  - `defaultTtsProvider=replicate` (or your preferred shared slug).
  - `showAllProviderModels=false` if you want users locked to each provider's default model.
  - `enableAudiobookExport=true`.

## 3. Runtime JSON seed (optional)

If you must pre-seed site features/providers at deploy time, use `RUNTIME_SEED_JSON` or `RUNTIME_SEED_JSON_PATH` (versioned JSON seed document). Prefer the admin panel for ongoing management.

See [Environment Variables](../reference/environment-variables#runtime-json-seed) for schema and examples.

:::warning Auth recommendation
Set both `BASE_URL` and `AUTH_SECRET` — they are required for startup, the admin panel, and
encrypting admin-stored TTS credentials. Keep `AUTH_SECRET` stable across deployments.
:::

:::warning Rotating AUTH_SECRET invalidates admin-stored keys
Admin-managed TTS provider keys are encrypted with a key derived from `AUTH_SECRET`. If you rotate `AUTH_SECRET` after the first deploy, you must re-enter each admin shared provider's API key from the UI.
:::

:::tip
For all variables and defaults, see [Environment Variables](../reference/environment-variables).
:::

## 4. Upgrade from v4.4 to v5

Vercel deployments do not run the `@openreader/bootstrap` process, so automatic startup migrations do not run there.

1. Take the v4 app offline or pause deployment traffic, then back up Postgres and the S3 bucket.
2. From a v5 source checkout, configure the production `POSTGRES_URL` and run `pnpm migrate`.
3. In the same controlled environment, configure the production `S3_INTERNAL_ENDPOINT`, bucket,
   region, access key, secret key, path-style setting, and prefix, then run
   `pnpm migrate-decommission` once.
4. Deploy the v5 worker and app with matching worker, credential-broker, playback, and S3 settings;
   configure the worker's NATS connection.
5. Check the migration output, then perform the smoke test below before restoring normal traffic.

The decommission command idempotently deletes only the retired v4 object roots
`tts_segments_v1/`, `tts_segments_v2/`, and `audiobooks_v1/`. It does not remove documents,
accounts, settings, or v5 playback artifacts. Re-running it is safe if a deployment is interrupted.

For the full schema history and Docker's automatic path, see [Migrations](../configure/migrations).

## 5. Scheduled maintenance tasks

The repository configures `/api/admin/tasks/tick` as a Vercel Cron route. Set `CRON_SECRET`; requests without the matching bearer token are rejected.

The checked-in Hobby-compatible schedule invokes the route once daily. The admin task panel therefore prevents selecting intervals shorter than one day on Vercel, even though self-hosted deployments can run tasks more frequently.

Each due task is claimed with a database-backed lease, due tasks start independently, and individual runs are aborted and marked failed after four minutes. Review failures and run tasks manually from **Settings → Admin → Scheduled tasks**.

## 6. Runtime expectations and caveats

- Playback and audiobook export require the external compute worker and S3-compatible object
  storage because generation continues outside the serverless request lifecycle.
- For production Vercel deploys, use `POSTGRES_URL` instead of SQLite.

## 7. Smoke test after deploy

1. Upload and read a PDF/EPUB document.
2. Confirm sync/blob fetch works across refreshes/devices.
3. Start TTS playback and download an audiobook MP3 export.
4. Verify worker-backed word highlighting and PDF parsing.
5. Open **Settings → Admin → Scheduled tasks**, run one task manually, and confirm the next daily cron invocation succeeds.
