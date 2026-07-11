---
title: Docker Compose
description: Run OpenReader with the slim, full, local-slim, or local-full Docker Compose examples.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Use these examples to run OpenReader with Kokoro-FastAPI and persistent storage. Choose the slim
stack for the simplest deployment, or the full stack when you want PostgreSQL, SeaweedFS, NATS,
and the compute worker as separate containers. Local build variants are also available for both slim
and full stacks to build the application from your current checkout.

## Prerequisites

- A recent Docker version with Docker Compose
- A clone of the OpenReader repository

```bash
git clone https://github.com/richardr1126/openreader.git
cd openreader
```

## Choose a stack

<Tabs groupId="docker-compose-stack">
<TabItem value="slim" label="Slim" default>

The default slim example runs:

- OpenReader with embedded SeaweedFS, NATS, compute worker, and SQLite
- Kokoro-FastAPI as a companion container

```bash
docker compose -f docker/examples/compose.yml up
# Repository convenience command: pnpm compose
```

Compose file: [`docker/examples/compose.yml`](https://github.com/richardr1126/openreader/blob/main/docker/examples/compose.yml)

</TabItem>
<TabItem value="full" label="Full">

The full example runs OpenReader, Kokoro-FastAPI, PostgreSQL, SeaweedFS, NATS, and the compute
worker as separate containers using published images.

```bash
docker compose -f docker/examples/compose.full.yml up
# Repository convenience command: pnpm compose:full
```

Compose file: [`docker/examples/compose.full.yml`](https://github.com/richardr1126/openreader/blob/main/docker/examples/compose.full.yml)

For details about running the worker separately, see
[Compute Worker](./compute-worker).

</TabItem>
<TabItem value="local-slim" label="Local Slim">

The local-slim example runs a slim setup (OpenReader and Kokoro-FastAPI), but builds the OpenReader app image from the current checkout.

```bash
docker compose -f docker/examples/compose.local-slim.yml up --build
# Repository convenience command: pnpm compose:local
```

Compose file: [`docker/examples/compose.local-slim.yml`](https://github.com/richardr1126/openreader/blob/main/docker/examples/compose.local-slim.yml)

</TabItem>
<TabItem value="local-full" label="Local Full">

The local-full example uses the full multi-container layout, but builds the OpenReader app and compute-worker images from the current checkout.

```bash
docker compose -f docker/examples/compose.local-full.yml up --build
# Repository convenience command: pnpm compose:local:full
```

Compose file: [`docker/examples/compose.local-full.yml`](https://github.com/richardr1126/openreader/blob/main/docker/examples/compose.local-full.yml)

</TabItem>
</Tabs>

## Included services

| Service | Slim | Full | Local Slim | Local Full |
| --- | --- | --- | --- | --- |
| OpenReader | Published image | Published image | Local build | Local build |
| Kokoro-FastAPI | Container | Container | Container | Container |
| Database | Embedded SQLite | PostgreSQL container | Embedded SQLite | PostgreSQL container |
| SeaweedFS | Embedded | Container | Embedded | Container |
| NATS | Embedded | Container | Embedded | Container |
| Compute worker | Embedded | Published image | Embedded | Local build |

On first boot, `RUNTIME_SEED_JSON` creates an enabled Kokoro shared provider and selects it as the
default TTS provider.

## Endpoints

- OpenReader: `http://localhost:3003`
- SeaweedFS S3: `http://localhost:8333`
- Kokoro-FastAPI: `http://localhost:8880`
- Compute worker playback audio in full stacks: `http://localhost:8081`

In the full examples, PostgreSQL and NATS remain internal to the Compose network. The compute
worker API still uses the internal `http://compute-worker:8081` URL from the app, but port `8081`
is also published so browsers can load signed worker-owned TTS playback audio.

## LAN access

Set `BASE_URL` to the Docker host's LAN IP for the default same-origin proxy topology:

<Tabs groupId="docker-compose-lan-stack">
<TabItem value="slim" label="Slim" default>

```bash
BASE_URL=http://192.168.0.XXX:3003 \
docker compose -f docker/examples/compose.yml up
# Repository convenience command: pnpm compose
```

</TabItem>
<TabItem value="full" label="Full">

```bash
BASE_URL=http://192.168.0.XXX:3003 \
COMPUTE_WORKER_PUBLIC_URL=http://192.168.0.XXX:8081 \
docker compose -f docker/examples/compose.full.yml up
# Repository convenience command: pnpm compose:full
```

</TabItem>
<TabItem value="local-slim" label="Local Slim">

```bash
BASE_URL=http://192.168.0.XXX:3003 \
docker compose -f docker/examples/compose.local-slim.yml up --build
# Repository convenience command: pnpm compose:local
```

</TabItem>
<TabItem value="local-full" label="Local Full">

```bash
BASE_URL=http://192.168.0.XXX:3003 \
COMPUTE_WORKER_PUBLIC_URL=http://192.168.0.XXX:8081 \
docker compose -f docker/examples/compose.local-full.yml up --build
# Repository convenience command: pnpm compose:local:full
```

</TabItem>
</Tabs>

Replace `192.168.0.XXX` with your Docker host's LAN IP. Allow inbound TCP port `3003`, plus
`8081` when using full stacks with the standalone compute worker. The embedded/proxy storage endpoint does not need browser access.

:::info Internal full-stack endpoint
The full and local-full app and compute workers use `http://seaweedfs:8333` internally.
For direct browser storage, configure `S3_BROWSER_TRANSPORT=presigned` and a public HTTPS `S3_PUBLIC_ENDPOINT`; do not use a path-mounted S3 reverse proxy.
`COMPUTE_WORKER_PUBLIC_URL` configures the browser-facing worker playback audio URL.
:::

## Configuration

The examples use local-only default credentials. Override existing `${VARIABLE}` values through
your shell environment before using them beyond local development.

:::warning Protect public deployments
Replace the default `AUTH_SECRET`, PostgreSQL credentials, S3 credentials, compute-worker token,
and `TTS_PLAYBACK_TOKEN_SECRET` before exposing a stack outside your trusted local network.
:::

For the complete configuration reference, see
[Environment Variables](../reference/environment-variables). See [Database](../configure/database)
for PostgreSQL and SQLite behavior.
