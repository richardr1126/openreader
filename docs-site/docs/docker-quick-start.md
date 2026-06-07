---
title: Docker Quick Start
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Prerequisites

- A recent Docker version installed
- A TTS API server that OpenReader can reach:
  - [Kokoro-FastAPI](./configure/tts-provider-guides/kokoro-fastapi)
  - [KittenTTS-FastAPI](./configure/tts-provider-guides/kitten-tts-fastapi)
  - [Orpheus-FastAPI](./configure/tts-provider-guides/orpheus-fastapi)
  - [Replicate](./configure/tts-provider-guides/replicate)
  - [DeepInfra](./configure/tts-provider-guides/deepinfra)
  - [OpenAI](./configure/tts-provider-guides/openai)
  - [Other OpenAI-compatible providers](./configure/tts-provider-guides/other)

:::warning SeaweedFS Compatibility Note (April 16, 2026)
OpenReader currently pins embedded SeaweedFS to `4.18` in CI and Docker builds.
`4.19` introduced intermittent `InternalError` responses on S3 `PutObject` in our upload flow.
:::

## Published images

- App server: `ghcr.io/richardr1126/openreader:latest`
- Compute worker (Optional): `ghcr.io/richardr1126/openreader-compute-worker:latest`
- Legacy app alias: `ghcr.io/richardr1126/openreader-webui:latest`

## 1. Start the Docker container

<Tabs groupId="docker-start-mode">
<TabItem value="localhost" label="Localhost" default>

Persistent storage, embedded SeaweedFS `weed mini`, required auth, optional library mount:

```bash
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  -v openreader_docstore:/app/docstore \
  -e API_BASE=http://host.docker.internal:8880/v1 \
  -e BASE_URL=http://localhost:3003 \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_EMAILS=you@example.com \
  ghcr.io/richardr1126/openreader:latest
```

What this command enables:

- `-p 3003:3003`: exposes the OpenReader web app/API.
- `-p 8333:8333`: exposes embedded SeaweedFS S3 endpoint for direct browser presigned upload/download.
- `-v openreader_docstore:/app/docstore`: persists SQLite metadata, SeaweedFS blob data, and migration/runtime state.
- `-e API_BASE=...` / optional `-e API_KEY=...`: **first-boot seed only.** On the first container start, these are auto-migrated into a `default-openai` admin shared provider stored in the DB (key encrypted at rest when provided). After that, the running app no longer reads them — manage the provider from **Settings → Admin → Shared providers**. See [Admin Panel](./configure/admin-panel).
- `-e BASE_URL=...` and `-e AUTH_SECRET=...`: required for v4+ auth/session startup.
- `-e ADMIN_EMAILS=...`: (optional, requires auth) comma-separated emails auto-promoted to admin. Admins see the **Admin** tab in Settings.

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
  -e ADMIN_EMAILS=you@example.com \
  ghcr.io/richardr1126/openreader:latest
```

Replace `YOUR_LAN_IP` with the Docker host IP address on your local network to allow access from other devices.

What this command enables:

- LAN access from phones/tablets/other computers via `http://<YOUR_LAN_IP>:3003`.
- `BASE_URL` points auth/session cookies and callbacks at your LAN URL.
- `AUTH_TRUSTED_ORIGINS` allows localhost loopback origins in addition to your primary LAN origin.
- `USE_ANONYMOUS_AUTH_SESSIONS=true` allows guest sessions while auth is enabled.
- `API_BASE` seeds the default TTS endpoint into the admin-managed `default-openai` shared provider on first boot. Edit it from **Settings → Admin → Shared providers** after that.
- `API_KEY` optionally seeds the default provider's key (encrypted at rest). Omit it for an upstream that does not require authentication.
- `ADMIN_EMAILS=...` (optional) auto-promotes the listed email(s) to admin so they can manage shared providers and site feature flags from the UI.
- `openreader_docstore` volume keeps data persistent across restarts.

</TabItem>
<TabItem value="minimal" label="Minimal">

Auth required, embedded storage ephemeral, no library import:

```bash
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8333:8333 \
  -e BASE_URL=http://localhost:3003 \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/richardr1126/openreader:latest
```

What this command enables:

- Fast startup with only the required auth env vars.
- No persistent volume (`/app/docstore` stays container-local), so data is ephemeral unless you add a mount.
- The app still requires `BASE_URL` + `AUTH_SECRET` in v4+, so include them even in minimal mode.
- No TTS provider preset by default. Configure `API_BASE` and, when required, `API_KEY` on first boot if you want a seeded shared provider, or run auth+admin mode and manage providers from the admin panel.

</TabItem>
</Tabs>

:::tip Quick Tips
- Set `API_BASE` on first boot to a TTS endpoint the container can reach (`host.docker.internal` works for host-local services). After first boot, manage providers in **Settings → Admin → Shared providers**.
- `BASE_URL` and `AUTH_SECRET` are required in v4+. The admin panel requires auth.
- Set `ADMIN_EMAILS` to your email if you want the **Admin** tab in Settings.
- `restrictUserApiKeys` controls shared-provider-only mode. For per-user BYOK, toggle it off in **Settings → Admin → Site features** or seed `runtimeConfig.restrictUserApiKeys=false` via runtime seed JSON.
- Use a `/app/docstore` mount if you want data to survive container/image replacement.
- Startup automatically runs DB/storage migrations via the shared entrypoint.
- Scheduled maintenance tasks run in-process and can be managed from **Settings → Admin → Scheduled tasks**; Docker/self-hosted deployments do not need `CRON_SECRET`.
:::

:::warning Port `8333` Exposure
Expose `8333` for direct browser presigned upload/download with embedded SeaweedFS.

If `8333` is not reachable from the browser, direct presigned access is unavailable. Uploads can still fall back to `/api/documents/blob/upload/fallback`, and document reads/downloads continue through `/api/documents/blob`.
:::

## 2. Configure settings in the app UI

Visit [http://localhost:3003](http://localhost:3003) after startup.

- If you set `ADMIN_EMAILS`, sign in with that email and open **Settings → Admin** to manage shared TTS providers and site feature flags for all users.
- Per-user: set TTS provider/model in **Settings → TTS Provider**. API key/base URL inputs are shown only when `restrictUserApiKeys=false`.
- Select the model voice from the voice dropdown.

## 3. Update Docker image

Legacy image compatibility: `ghcr.io/richardr1126/openreader-webui:latest` remains available as an alias.
For external compute mode image details, see [Compute Worker (NATS JetStream)](./deploy/compute-worker).

```bash
docker stop openreader || true && \
docker rm openreader || true && \
docker image rm ghcr.io/richardr1126/openreader:latest || true && \
docker pull ghcr.io/richardr1126/openreader:latest
```

:::tip
If you use a mounted volume for `/app/docstore`, your persisted data remains after image updates.
:::

:::info Related Docs
- [Environment Variables](./reference/environment-variables)
- [Auth](./configure/auth)
- [Admin Panel](./configure/admin-panel)
- [Database](./configure/database)
- [Object / Blob Storage](./configure/object-blob-storage)
- [Migrations](./configure/migrations)
:::
