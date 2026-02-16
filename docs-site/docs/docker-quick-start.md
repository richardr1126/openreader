---
title: Docker Quick Start
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Prerequisites

- A recent Docker version installed
- A TTS API server that OpenReader can reach (Kokoro-FastAPI, Orpheus-FastAPI, DeepInfra, OpenAI, or equivalent)

:::note
If you have suitable hardware, you can run Kokoro locally with Docker. See [Kokoro-FastAPI](./configure/tts-provider-guides/kokoro-fastapi).
:::

## 1. Start the Docker container

<Tabs groupId="docker-start-mode">
  <TabItem value="minimal" label="Minimal" default>

Auth disabled, embedded storage ephemeral, no library import:

```bash
docker run --name openreader-webui \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  ghcr.io/richardr1126/openreader-webui:latest
```

  </TabItem>
  <TabItem value="full" label="Full Setup">

Persistent storage, embedded SeaweedFS `weed mini`, optional auth, optional library mount:

```bash
docker run --name openreader-webui \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  -v openreader_docstore:/app/docstore \
  -v /path/to/your/library:/app/docstore/library:ro \
  -e API_BASE=http://host.docker.internal:8880/v1 \
  -e API_KEY=none \
  -e BASE_URL=http://localhost:3003 \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/richardr1126/openreader-webui:latest
```

  </TabItem>
</Tabs>

:::tip
Remove `/app/docstore/library` if you do not need server library import.
:::

:::tip
Remove either `BASE_URL` or `AUTH_SECRET` to keep auth disabled.
:::

:::tip TTS API Base
Set `API_BASE` to your reachable TTS server base URL.
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

```bash
docker stop openreader-webui || true && \
docker rm openreader-webui || true && \
docker image rm ghcr.io/richardr1126/openreader-webui:latest || true && \
docker pull ghcr.io/richardr1126/openreader-webui:latest
```

:::tip
If you use a mounted volume for `/app/docstore`, your persisted data remains after image updates.
:::

Visit [http://localhost:3003](http://localhost:3003) after startup.
