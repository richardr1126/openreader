title: Compute Worker (NATS JetStream)
---

Use this guide for `COMPUTE_MODE=worker` deployments where heavy compute runs outside the Next.js app server.

## Overview

The compute worker handles:

- Whisper word alignment operations
- PDF layout parsing operations

The app server submits operations to `POST /ops`, reuses in-flight work via required `opKey`, and consumes status updates via `GET /ops/:opId/events` (SSE). Queue durability and retries are backed by NATS JetStream WorkQueue consumers and NATS KV.

## Published image

- App server image: `ghcr.io/richardr1126/openreader`
- Compute worker image: `ghcr.io/richardr1126/openreader-compute-worker`
- Compute worker image (example pinned tag): `ghcr.io/richardr1126/openreader-compute-worker:refactor-ppdoclayoutv3-onnx-layout-parsing`

## Worker environment variables

Required:

- `COMPUTE_WORKER_TOKEN`: bearer token expected by worker routes
- `NATS_URL`: NATS server connection string (JetStream enabled)
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

> [!IMPORTANT]
> **S3 credentials cannot be left blank/empty** when running in worker mode.
> While the main Next.js server can generate random, dynamic S3 keys on-the-fly when `USE_EMBEDDED_WEED_MINI=true` and `S3_*` vars are blank, the compute worker runs in a separate process and cannot connect to SeaweedFS using those dynamically generated keys. 
> To use the compute worker with the embedded SeaweedFS, you **must configure identical, stable S3 credentials** (e.g. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`) in both the root `.env` and the compute worker `.env` files.

Common optional:

- `NATS_CREDS`: raw user credentials file content (JWT + private key), ideal for cloud container environments where mounting files is difficult.
- `NATS_CREDS_FILE`: path to a `.creds` file on the server.
- `S3_ENDPOINT` (for non-AWS S3-compatible storage)
- `S3_FORCE_PATH_STYLE=true` (for many S3-compatible providers)
- `S3_PREFIX=openreader`
- `COMPUTE_WORKER_HOST=0.0.0.0`
- `PORT=8081` (local/manual; on Railway platform injects this)
- `COMPUTE_LOG_FORMAT=pretty` (default) or `json`

Advanced tuning (usually leave unset unless you need overrides):

- `COMPUTE_PREWARM_MODELS=true`
- `COMPUTE_WHISPER_CONCURRENCY=1`
- `COMPUTE_PDF_CONCURRENCY=2`
- `COMPUTE_WHISPER_TIMEOUT_MS=30000`
- `COMPUTE_PDF_TIMEOUT_MS=90000`
- `COMPUTE_PDF_JOB_ATTEMPTS=2` (PDF layout retry attempts)
- `COMPUTE_JOBS_STREAM_MAX_BYTES=268435456` (256MB JetStream jobs stream cap)
- `COMPUTE_JOB_STATES_MAX_BYTES=67108864` (64MB JetStream KV bucket cap)
- `COMPUTE_OP_STALE_MS=1800000` (stale op replacement window)

## App server environment variables (worker mode)

Set on the Next.js app server:

```env
COMPUTE_MODE=worker
# Local worker example:
# COMPUTE_WORKER_URL=http://localhost:8081
# Cloud worker example (Railway):
COMPUTE_WORKER_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
```

`COMPUTE_MODE=worker` has no local fallback. If worker is unavailable, affected requests fail.

## Production notes

- Worker mode assumes shared object storage is reachable by both app server and worker.
- Non-exposed embedded `weed mini` is not supported with external worker mode.
- Protect `COMPUTE_WORKER_TOKEN` and avoid exposing worker routes publicly without auth.

## Health endpoints

- `GET /health/live`
- `GET /health/ready`

## Synadia Cloud + Railway Setup (Complete Guide)

Use this end-to-end guide when your queue backend is Synadia Cloud (NGS) and your worker runs on Railway.

### 1. Create Synadia account and credentials

1. Create a Synadia Cloud account and create/select your NGS environment.
2. Create a user or service account for OpenReader compute worker access.
3. Download the generated credentials file (usually `<name>.creds`) and keep it secure.

You will use:

- `NATS_URL=tls://connect.ngs.global:4222`
- The full `.creds` file content

### 2. Deploy compute worker on Railway

Create a Railway service from:

```text
ghcr.io/richardr1126/openreader-compute-worker:refactor-ppdoclayoutv3-onnx-layout-parsing
```

Railway injects a dynamic `PORT` env var and routes traffic there.
Do not hardcode Railway ingress to `8081`; keep service networking enabled and use the public Railway URL.

### 3. Configure Railway worker environment variables

Set these in the Railway worker service:

```env
COMPUTE_WORKER_HOST=0.0.0.0
# Local/manual only:
# PORT=8081
# Railway: rely on injected PORT
COMPUTE_WORKER_TOKEN=<long-random-shared-token>
# Optional advanced tuning overrides (defaults shown):
# COMPUTE_PREWARM_MODELS=true
# COMPUTE_WHISPER_CONCURRENCY=1
# COMPUTE_PDF_CONCURRENCY=2
# COMPUTE_WHISPER_TIMEOUT_MS=30000
# COMPUTE_PDF_TIMEOUT_MS=90000
# COMPUTE_PDF_JOB_ATTEMPTS=2
# COMPUTE_JOBS_STREAM_MAX_BYTES=268435456
# COMPUTE_JOB_STATES_MAX_BYTES=67108864

NATS_URL=tls://connect.ngs.global:4222
NATS_CREDS="-----BEGIN NATS USER JWT-----
...
------END USER NKEY SEED------"

S3_BUCKET=<bucket>
S3_REGION=<region>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_ENDPOINT=<optional-for-s3-compatible-providers>
S3_FORCE_PATH_STYLE=true
S3_PREFIX=openreader
```

Notes:

- `NATS_CREDS` should be the full Synadia `.creds` file content, including begin/end markers.
- Keep `COMPUTE_WORKER_TOKEN` identical between app server and worker.
- On Railway, leave `PORT` managed by the platform.
- If your platform supports mounted files, you can use `NATS_CREDS_FILE` instead of `NATS_CREDS`.
- `COMPUTE_JOBS_STREAM_MAX_BYTES` and `COMPUTE_JOB_STATES_MAX_BYTES` are optional; defaults are `268435456` (256MiB) and `67108864` (64MiB).

### 4. Configure the OpenReader app server (worker mode)

Set these env vars on the app server:

```env
COMPUTE_MODE=worker
COMPUTE_WORKER_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
```

### 5. Verify health

After deploy, check:

- `GET https://<railway-worker-domain>/health/live`
- `GET https://<railway-worker-domain>/health/ready`
