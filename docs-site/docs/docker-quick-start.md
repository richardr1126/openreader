---
title: Docker Quick Start
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Prerequisites

- A recent Docker version installed
- A TTS API server that OpenReader can reach (Kokoro-FastAPI, KittenTTS-FastAPI, Orpheus-FastAPI, DeepInfra, OpenAI, or equivalent)

:::note
If you have suitable hardware, you can run Kokoro locally with Docker. See [Kokoro-FastAPI](./configure/tts-provider-guides/kokoro-fastapi).
:::

## 1. Start the Docker container

<Tabs groupId="docker-start-mode">
  <TabItem value="minimal" label="Minimal" default>

Auth disabled, embedded storage ephemeral, no library import:

```bash
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  ghcr.io/richardr1126/openreader:latest
```

  </TabItem>
  <TabItem value="localhost" label="Localhost">

Persistent storage, embedded SeaweedFS `weed mini`, optional auth, optional library mount:

```bash
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  -v openreader_docstore:/app/docstore \
  -v /path/to/your/library:/app/docstore/library:ro \
  -e API_BASE=http://host.docker.internal:8880/v1 \
  -e API_KEY=none \
  -e BASE_URL=http://localhost:3003 \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/richardr1126/openreader:latest
```

  </TabItem>
  <TabItem value="local-network" label="LAN Host">

Use this when the app should be reachable from other devices on your LAN:

```bash
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  -v openreader_docstore:/app/docstore \
  -e API_BASE=http://host.docker.internal:8880/v1 \
  -e BASE_URL=http://<YOUR_LAN_IP>:3003 \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  -e AUTH_TRUSTED_ORIGINS=http://localhost:3003,http://127.0.0.1:3003 \
  -e USE_ANONYMOUS_AUTH_SESSIONS=true \
  ghcr.io/richardr1126/openreader:latest
```

Replace `<YOUR_LAN_IP>` with the Docker host IP address on your local network to allow access from other devices.

  </TabItem>
</Tabs>

:::tip Quick Tips
- Remove `/app/docstore/library` if you do not need server library import.
- Remove either `BASE_URL` or `AUTH_SECRET` to keep auth disabled.
- Set `API_BASE` to your reachable TTS server base URL.
:::

:::warning Port `8333` Exposure
Expose `8333` for direct browser presigned upload/download with embedded SeaweedFS.

If `8333` is not reachable from the browser, direct presigned access is unavailable. Uploads can still fall back to `/api/documents/blob/upload/fallback`, and document reads/downloads continue through `/api/documents/blob`.
:::

:::info Auth and Migrations
- Auth is enabled only when both `BASE_URL` and `AUTH_SECRET` are set.
- DB/storage migrations run automatically at container startup via the shared entrypoint.
:::

:::info Related Docs
- [Environment Variables](./reference/environment-variables)
- [Auth](./configure/auth)
- [Database](./configure/database)
- [Object / Blob Storage](./configure/object-blob-storage)
- [Migrations](./configure/migrations)
:::

## 2. Configure settings in the app UI

- Set TTS provider and model in Settings
- Set TTS API base URL and API key if needed
- Select the model voice from the voice dropdown

## 3. Update Docker image

Legacy image compatibility: `ghcr.io/richardr1126/openreader-webui:latest` remains available as an alias.

```bash
docker stop openreader || true && \
docker rm openreader || true && \
docker image rm ghcr.io/richardr1126/openreader:latest || true && \
docker pull ghcr.io/richardr1126/openreader:latest
```

:::tip
If you use a mounted volume for `/app/docstore`, your persisted data remains after image updates.
:::

Visit [http://localhost:3003](http://localhost:3003) after startup.
