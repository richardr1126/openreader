title: Compute Worker (NATS JetStream)
---

Use this guide when compute-worker runs as a standalone service outside the Next.js app server.
For embedded/local startup (`pnpm dev` / `pnpm start` without `COMPUTE_WORKER_URL`), use root `.env` instead.

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
> This file (`compute/worker/.env*`) is only for standalone worker deployments.
> In embedded/local startup, app entrypoint spawns worker with the already-resolved root `.env` values.
> For standalone worker deployments, keep shared app/worker values aligned:
> - `COMPUTE_WORKER_TOKEN`
> - shared object storage settings (`S3_*`)
> - shared timeout/stale settings (`COMPUTE_WHISPER_TIMEOUT_MS`, `COMPUTE_PDF_TIMEOUT_MS`, `COMPUTE_OP_STALE_MS`)

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
- `COMPUTE_JOB_CONCURRENCY=1` (shared total compute jobs across whisper + PDF)
- `COMPUTE_WHISPER_TIMEOUT_MS=30000`
- `COMPUTE_PDF_TIMEOUT_MS=300000`
- `WHISPER_MODEL_BASE_URL=https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main` (optional override, q4 defaults)
- `PDF_LAYOUT_MODEL_BASE_URL=https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main` (optional override)
- `COMPUTE_PDF_JOB_ATTEMPTS=1` (PDF layout retry attempts)
- `COMPUTE_JOBS_STREAM_MAX_BYTES=268435456` (256MB JetStream jobs stream cap)
- `COMPUTE_JOB_STATES_MAX_BYTES=67108864` (64MB JetStream KV bucket cap)
- `COMPUTE_NATS_REPLICAS=1` (JetStream stream + KV replicas; valid: `1`, `3`, `5`)
- `COMPUTE_OP_STALE_MS=1800000` (stale op replacement window)

## App server environment variables

Set on the Next.js app server:

```env
# Local worker example:
# COMPUTE_WORKER_URL=http://localhost:8081
# Cloud worker example (Railway):
COMPUTE_WORKER_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
# Optional shared timeout overrides (keep equal to worker service values):
# COMPUTE_WHISPER_TIMEOUT_MS=30000
# COMPUTE_PDF_TIMEOUT_MS=300000
# COMPUTE_OP_STALE_MS=1800000
```

Model artifact overrides (`WHISPER_MODEL_BASE_URL`, `PDF_LAYOUT_MODEL_BASE_URL`) are worker runtime variables and should be set on the compute worker service environment. Current Whisper defaults expect q4 artifacts (`encoder_model_q4.onnx`, `decoder_model_merged_q4.onnx`, `decoder_with_past_model_q4.onnx`) under that base URL.

`COMPUTE_OP_STALE_MS` is shared by both services in worker mode:

- Worker: opKey stale replacement window in compute op state.
- App server: stale PDF parse-state healing window (`/api/documents/[id]/parsed*`).

Set the same value on app + worker envs.

There is no app-local compute fallback. If worker is unavailable, affected requests fail.

## Config ownership summary

- Embedded/local startup (`pnpm dev` / `pnpm start`, no `COMPUTE_WORKER_URL`):
  - Configure root `.env` only.
  - `compute/worker/.env*` is ignored.
- Standalone external worker service:
  - Configure app root `.env` with `COMPUTE_WORKER_URL` + `COMPUTE_WORKER_TOKEN`.
  - Configure worker service env (`compute/worker/.env*` or platform env).
  - Keep shared values aligned (`COMPUTE_WORKER_TOKEN`, `S3_*`, timeout/stale values).

## Production notes

- Worker mode assumes shared object storage is reachable by both app server and worker.
- Non-exposed embedded `weed mini` is not supported with external worker mode.
- Protect `COMPUTE_WORKER_TOKEN` and avoid exposing worker routes publicly without auth.

## Railway sleep & idle behavior

The worker connects to NATS lazily (on the first request needing the queue/KV) and
disconnects after **120s** of full idle — no in-flight request, SSE stream, job, or
queued work. This stops outbound pull polling and keepalive PINGs so Railway can sleep
it; the next inbound request transparently reconnects, re-ensures the stream/consumers
and KV (idempotent), and drains anything pending. No separate mode, no extra env vars,
and the `/ops*` contract is unchanged.

Caveats: inbound HTTP is the wake signal (in OpenReader the app server only enqueues via
`POST /ops`, so this is always satisfied); a continuous external `/health/*` probe keeps
it awake and prevents sleep; and the first request after a cold start re-runs model
prewarm, so it's slower.

## Health endpoints

- `GET /health/live` — liveness; always returns `{ ok: true }`.
- `GET /health/ready` — returns `{ ok: true, natsConnected }`. It does not probe NATS (that
  would reconnect and prevent idle sleep); `natsConnected` just reflects the current session.

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
# COMPUTE_JOB_CONCURRENCY=1
# COMPUTE_WHISPER_TIMEOUT_MS=30000
# COMPUTE_PDF_TIMEOUT_MS=300000
# WHISPER_MODEL_BASE_URL=https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main
# # Expects q4 files at that base:
# # - onnx/encoder_model_q4.onnx
# # - onnx/decoder_model_merged_q4.onnx
# # - onnx/decoder_with_past_model_q4.onnx
# PDF_LAYOUT_MODEL_BASE_URL=https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main
# COMPUTE_PDF_JOB_ATTEMPTS=1
# COMPUTE_JOBS_STREAM_MAX_BYTES=268435456
# COMPUTE_JOB_STATES_MAX_BYTES=67108864
# COMPUTE_NATS_REPLICAS=1

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
- `COMPUTE_NATS_REPLICAS` is optional; default is `1`. Valid values are `1`, `3`, `5`.

### 4. Configure the OpenReader app server

Set these env vars on the app server:

```env
COMPUTE_WORKER_URL=https://<railway-worker-domain>
COMPUTE_WORKER_TOKEN=<same-token-as-worker>
```

### 5. Verify health

After deploy, check:

- `GET https://<railway-worker-domain>/health/live`
- `GET https://<railway-worker-domain>/health/ready`
