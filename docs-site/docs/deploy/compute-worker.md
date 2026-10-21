---
title: Compute Worker
description: Run the compute worker as its own service, for Vercel or a dedicated compute host.
---

The compute worker does OpenReader's heavy work: speech generation, word timing, PDF layout analysis, previews, DOCX conversion, audiobook and account exports, and account email. It also serves playback audio directly to browsers.

Docker, `pnpm dev`/`pnpm start` and the desktop app run the worker inside OpenReader, so you only need this page to run it separately: on [Vercel](./vercel-deployment), where it cannot run inside the app, or on a dedicated compute host.

Image: `ghcr.io/richardr1126/openreader-compute-worker:latest`. Deploy the same version as the app.

## What it needs

- **NATS JetStream** for its job queue, such as a NATS server you run or Synadia Cloud. Only the worker connects to it.
- **The same object storage as the app.** The embedded SeaweedFS cannot be shared, so use an S3-compatible bucket.
- **A route to the app** to fetch provider keys, and a **public address** browsers can load audio from.
- **Network access to your TTS providers.** The worker makes the speech requests, so a self-hosted provider must be reachable from the worker's host (see [provider addresses](../configure/tts-providers#self-hosted-provider-addresses)).

The worker never connects to the database and never receives `AUTH_SECRET`.

## Shared values

Generate each once (for example with `openssl rand -base64 32`) and set the same value on both the app and the worker:

| Variable | Used for |
| --- | --- |
| `COMPUTE_WORKER_TOKEN` | The app's requests to the worker. |
| `COMPUTE_CREDENTIAL_BROKER_TOKEN` | The worker's requests to the app for provider keys. |
| `TTS_PLAYBACK_TOKEN_SECRET` | Signing the short-lived audio links browsers use. Changing it makes cached audio regenerate. |

None of them is ever sent to browsers.

## Worker settings

```env
COMPUTE_WORKER_TOKEN=<shared>
COMPUTE_CREDENTIAL_BROKER_URL=https://reader.example.com/api/internal/compute/tts-credentials
COMPUTE_CREDENTIAL_BROKER_TOKEN=<shared>
TTS_PLAYBACK_TOKEN_SECRET=<shared>

NATS_URL=nats://nats.example.com:4222
# NATS_CREDS=<contents of a .creds file>, or NATS_CREDS_FILE=/path/to/user.creds

S3_BUCKET=<same as the app>
S3_REGION=<same as the app>
S3_ACCESS_KEY_ID=<same as the app>
S3_SECRET_ACCESS_KEY=<same as the app>
S3_INTERNAL_ENDPOINT=<the same storage, at an address the worker can reach>
# S3_FORCE_PATH_STYLE and S3_PREFIX: same as the app

LOG_FORMAT=json
COMPUTE_LOG_LEVEL=info
```

The worker listens on `PORT` (default `8081`); most platforms set it for you. Timeouts, queue sizes, model download mirrors and model prewarming have defaults that rarely need changing; see [Environment Variables](../reference/environment-variables#compute-worker-and-model-configuration).

## App settings

```env
COMPUTE_WORKER_URL=https://worker.example.com
COMPUTE_WORKER_TOKEN=<shared>
COMPUTE_CREDENTIAL_BROKER_TOKEN=<shared>
TTS_PLAYBACK_TOKEN_SECRET=<shared>
# Only if browsers reach the worker at a different address:
# COMPUTE_WORKER_PUBLIC_URL=https://worker-public.example.com
```

Once `COMPUTE_WORKER_URL` is set, the app no longer starts an embedded worker. If the worker is down, playback and document processing fail until it is back.

If the app is served over HTTPS, the worker's public address must be HTTPS too, or browsers block the audio.

## Railway and Synadia Cloud

1. Create a Railway service from the worker image and turn on public networking.
2. Set the [worker settings](#worker-settings) above, with `NATS_URL=tls://connect.ngs.global:4222` and your Synadia user credentials in `NATS_CREDS` (or a mounted file in `NATS_CREDS_FILE`).
3. Set `COMPUTE_WORKER_URL=https://<railway-worker-domain>` on the app.

The worker disconnects from NATS after two minutes with nothing to do, so Railway can put the service to sleep. The first request after that takes longer.

## Health checks

- `GET /health/live` returns `{ "ok": true }` while the process is running.
- `GET /health/ready` also reports `natsConnected`.

After deploying, open **Settings → Admin → Maintenance** in the app. The system check confirms the app can reach the worker and that your browser can load its audio.
