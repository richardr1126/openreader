---
title: Vercel + External Worker
description: Run the OpenReader app on Vercel with Postgres, S3 storage and a separately hosted compute worker.
---

On Vercel, the app runs as serverless functions, so everything long-running happens elsewhere:

| Piece | Where it runs |
| --- | --- |
| App (sign-in, library, settings) | Vercel |
| Database | Postgres, such as Neon (`POSTGRES_URL`) |
| File storage | An S3-compatible bucket |
| Speech, alignment, PDF layout, previews, DOCX conversion, audiobooks | The [compute worker](./compute-worker), for example on Railway |
| Job queue | NATS JetStream, for example Synadia Cloud, reached only by the worker |

Deploy the same version of the app and the worker.

## 1. Deploy the worker

Set up the worker, its NATS connection and storage first, following [Compute Worker](./compute-worker). It ends with the three shared values the app also needs: `COMPUTE_WORKER_TOKEN`, `COMPUTE_CREDENTIAL_BROKER_TOKEN` and `TTS_PLAYBACK_TOKEN_SECRET`.

## 2. Set the app's environment variables

```bash
# Database and storage
POSTGRES_URL=postgres://...
USE_EMBEDDED_WEED_MINI=false
S3_BUCKET=...
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=openreader
# For AWS, both are https://s3.<region>.amazonaws.com
S3_INTERNAL_ENDPOINT=https://private-s3-endpoint.example
S3_PUBLIC_ENDPOINT=https://s3.example
# Non-AWS storage that needs path-style URLs:
# S3_FORCE_PATH_STYLE=true

# Sign-in
BASE_URL=https://your-app.vercel.app
AUTH_SECRET=...                 # openssl rand -base64 32; keep it stable
BOOTSTRAP_ADMIN_EMAIL=...       # new database only
BOOTSTRAP_ADMIN_PASSWORD=...    # at least 16 characters
CRON_SECRET=...                 # openssl rand -base64 32

# Compute worker (the same values as on the worker)
COMPUTE_WORKER_URL=https://<worker-domain>
COMPUTE_WORKER_TOKEN=...
COMPUTE_CREDENTIAL_BROKER_TOKEN=...
TTS_PLAYBACK_TOKEN_SECRET=...

# Logs in Vercel's format
LOG_FORMAT=json
LOG_LEVEL=info
```

The worker reaches the app at `https://<your-app-domain>/api/internal/compute/tts-credentials` to fetch provider keys, so set that as the worker's `COMPUTE_CREDENTIAL_BROKER_URL`.

Every variable is described in [Environment Variables](../reference/environment-variables).

## 3. Run migrations

Vercel does not run OpenReader's startup process, so migrations do not run on deploy. From a checkout of the version you are deploying, with the production `POSTGRES_URL` set, run:

```bash
pnpm migrate
```

Do this before deploying any release that adds migrations (see [Database and Migrations](../configure/database#migrations)). Upgrading from v4 has extra steps; see [Upgrade from v4](./upgrade-from-v4).

## 4. Deploy and set up

Deploy the app, then [create the first administrator](../configure/admin-panel#create-the-first-administrator), add a [TTS provider](../configure/tts-providers) and review [Instance Settings](../configure/instance-settings). Changes there apply without a redeploy.

Scheduled cleanup runs once a day through Vercel Cron, which needs `CRON_SECRET` (see [Maintenance](../configure/maintenance#how-tasks-are-triggered)).

## 5. Check the deployment

1. Open **Settings → Admin → Maintenance**. Every system check row should read **OK**.
2. Upload a PDF and an EPUB, and open them on a second device or after a refresh.
3. Play one, and confirm that words highlight as they are read.
4. Export a short audiobook.
5. In **Scheduled tasks**, run one task with **Run now**.
