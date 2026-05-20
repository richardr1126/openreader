title: Compute Worker (NATS JetStream)
---

Use this guide for `COMPUTE_MODE=worker` deployments where heavy compute runs outside the Next.js app server.

## Overview

The compute worker handles:

- Whisper word alignment (`/align/whisper/jobs`)
- PDF layout parsing (`/layout/pdf/jobs`)

The app server enqueues jobs and polls status. Queue durability and retries are backed by NATS JetStream WorkQueue consumers and NATS KV.

## Published image

- App server image: `ghcr.io/richardr1126/openreader`
- Compute worker image: `ghcr.io/richardr1126/openreader-compute-worker`

## Worker environment variables

Required:

- `COMPUTE_WORKER_TOKEN`: bearer token expected by worker routes
- `NATS_URL`: NATS server connection string (JetStream enabled)
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

Common optional:

- `S3_ENDPOINT` (for non-AWS S3-compatible storage)
- `S3_FORCE_PATH_STYLE=true` (for many S3-compatible providers)
- `S3_PREFIX=openreader`
- `COMPUTE_WORKER_HOST=0.0.0.0`
- `COMPUTE_WORKER_PORT=8081`
- `COMPUTE_LOG_FORMAT=pretty` (default) or `json`
- `COMPUTE_PREWARM_MODELS=true`

## App server environment variables (worker mode)

Set on the Next.js app server:

```env
COMPUTE_MODE=worker
COMPUTE_WORKER_URL=http://<worker-host>:8081
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
