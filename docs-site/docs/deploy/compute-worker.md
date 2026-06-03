---
title: Compute Worker
description: Deploy the standalone worker used for Whisper alignment and PDF layout parsing.
---

Use this guide when OpenReader runs compute as a separate service. For the default embedded/local flow (`pnpm dev` or `pnpm start` without `COMPUTE_WORKER_URL`), configure the root `.env` instead and see [Local Development](./local-development).

## What the worker does

- Runs Whisper word alignment jobs
- Runs PDF layout parsing jobs
- Stores durable job state in NATS JetStream and NATS KV

The app server submits work to `POST /ops` and listens for updates on `GET /ops/:opId/events`.

## When to use it

- Required for Vercel-style deployments where heavy compute must run outside the app server
- Useful when you want a dedicated compute host
- Not needed for the default embedded local flow

## Container image

- `ghcr.io/richardr1126/openreader-compute-worker:latest`

## Worker environment

Required worker variables:

```env
COMPUTE_WORKER_TOKEN=...
NATS_URL=nats://...
S3_BUCKET=...
S3_REGION=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

:::important
`compute/worker/.env*` is only for standalone worker deployments.

- Embedded/local mode: configure the root `.env` only.
- External worker mode: set `COMPUTE_WORKER_URL` and `COMPUTE_WORKER_TOKEN` on the app, and worker runtime values on the worker service.
- Keep shared values aligned across app and worker: `COMPUTE_WORKER_TOKEN`, `S3_*`, `COMPUTE_WHISPER_TIMEOUT_MS`, `COMPUTE_PDF_TIMEOUT_MS`, `COMPUTE_PDF_JOB_ATTEMPTS`, and `COMPUTE_OP_STALE_MS`.
:::

Common optional variables:

- `NATS_CREDS` or `NATS_CREDS_FILE`
- `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=true`, `S3_PREFIX=openreader`
- `COMPUTE_WORKER_HOST=0.0.0.0`
- `PORT=8081` for local/manual runs. Platforms like Railway usually inject `PORT`.
- `LOG_FORMAT=json` and `COMPUTE_LOG_LEVEL=info`
- `COMPUTE_PREWARM_MODELS=false` by default. Set it to `true` to pre-download ONNX models during worker startup.
- `COMPUTE_JOB_CONCURRENCY=1`
- `COMPUTE_WHISPER_TIMEOUT_MS=30000`
- `COMPUTE_PDF_TIMEOUT_MS=300000`
- `COMPUTE_PDF_JOB_ATTEMPTS=1`
- `COMPUTE_JOBS_STREAM_MAX_BYTES=268435456`
- `COMPUTE_EVENTS_STREAM_MAX_BYTES=134217728`
- `COMPUTE_JOB_STATES_MAX_BYTES=67108864`
- `COMPUTE_NATS_REPLICAS=1`
- `COMPUTE_OP_STALE_MS=1800000`
- `WHISPER_MODEL_BASE_URL`
- `PDF_LAYOUT_MODEL_BASE_URL`

If you need the broader app config reference, see [Environment Variables](../reference/environment-variables).

## App server environment

Set these on the Next.js app server:

```env
COMPUTE_WORKER_URL=https://worker.example.com
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
# Optional shared overrides:
# COMPUTE_WHISPER_TIMEOUT_MS=30000
# COMPUTE_PDF_TIMEOUT_MS=300000
# COMPUTE_PDF_JOB_ATTEMPTS=1
# COMPUTE_OP_STALE_MS=1800000
```

Notes:

- Model artifact overrides (`WHISPER_MODEL_BASE_URL`, `PDF_LAYOUT_MODEL_BASE_URL`) belong on the worker service, not the app server.
- There is no app-local compute fallback once `COMPUTE_WORKER_URL` is set. If the worker is unavailable, worker-backed requests fail.

## Deployment notes

- App and worker must share the same object storage.
- Embedded `weed mini` is not supported for external worker mode.
- Protect `COMPUTE_WORKER_TOKEN` and do not expose worker routes without auth.
- The worker connects to NATS lazily and disconnects after 120 seconds of full idle time. That allows platforms like Railway to sleep the service, but the first request after a cold start will be slower.

## Health endpoints

- `GET /health/live` returns `{ ok: true }`.
- `GET /health/ready` returns `{ ok: true, natsConnected }` and reflects the current NATS session without forcing a reconnect.

## Railway + Synadia example

Deploy the worker image to Railway and set worker env vars similar to:

```env
COMPUTE_WORKER_HOST=0.0.0.0
COMPUTE_WORKER_TOKEN=<shared-token>
NATS_URL=tls://connect.ngs.global:4222
NATS_CREDS="-----BEGIN NATS USER JWT-----
...
------END USER NKEY SEED------"
S3_BUCKET=<bucket>
S3_REGION=<region>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
# Optional:
# S3_ENDPOINT=https://...
# S3_FORCE_PATH_STYLE=true
# S3_PREFIX=openreader
```

If your platform supports mounted files, you can use `NATS_CREDS_FILE` instead of `NATS_CREDS`.

Set these on the OpenReader app server:

```env
COMPUTE_WORKER_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
```

Verify the worker after deploy:

- `GET https://<railway-worker-domain>/health/live`
- `GET https://<railway-worker-domain>/health/ready`
