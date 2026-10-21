---
title: Docker Compose
description: Run OpenReader with the slim or full Docker Compose examples.
---

The repository's Compose examples run OpenReader with [Kokoro-FastAPI](../configure/tts-provider-guides/kokoro-fastapi) and persistent storage. For the fastest start, follow the [Docker Quick Start](../docker-quick-start); this page covers every variant and production settings.

## Choose a stack

| File | Runs | Use it for |
| --- | --- | --- |
| [`compose.yml`](https://github.com/richardr1126/openreader/blob/main/examples/docker/compose.yml) (slim) | OpenReader with its embedded storage, NATS, worker and SQLite, plus Kokoro-FastAPI | Most installs. |
| [`compose.full.yml`](https://github.com/richardr1126/openreader/blob/main/examples/docker/compose.full.yml) (full) | OpenReader, Kokoro-FastAPI, PostgreSQL, SeaweedFS, NATS and the worker as separate containers | Postgres, or managing each service yourself. |
| [`compose.local-slim.yml`](https://github.com/richardr1126/openreader/blob/main/examples/docker/compose.local-slim.yml), [`compose.local-full.yml`](https://github.com/richardr1126/openreader/blob/main/examples/docker/compose.local-full.yml) | The same, built from your checkout | Testing changes. |

All files are in `examples/docker/`. Start one from the repository root:

```bash
git clone https://github.com/richardr1126/openreader.git
cd openreader
docker compose -f examples/docker/compose.yml up -d
```

For the local variants, add `--build`. The repository also has shortcuts: `pnpm compose`, `pnpm compose:full`, `pnpm compose:local` and `pnpm compose:local:full`.

On first start, the stack adds Kokoro-FastAPI as the default voice provider.

## Set your secrets

The examples fall back to built-in development values, so they start without configuration. Those values are public. Before the stack is reachable by anyone else, put your own in `examples/docker/.env` and keep it. Compose reads the `.env` next to the Compose file, not one in the repository root:

```dotenv
AUTH_SECRET=<openssl rand -base64 32>
TTS_PLAYBACK_TOKEN_SECRET=<openssl rand -base64 32>

# New installs: the first administrator
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>

# Full stacks only
COMPUTE_WORKER_TOKEN=<openssl rand -base64 32>
COMPUTE_CREDENTIAL_BROKER_TOKEN=<openssl rand -base64 32>
S3_ACCESS_KEY_ID=<your-choice>
S3_SECRET_ACCESS_KEY=<your-choice>
```

- Keep `AUTH_SECRET` the same forever. It also encrypts saved provider keys ([details](../configure/admin-panel#how-saved-keys-are-protected)). Changing `TTS_PLAYBACK_TOKEN_SECRET` makes cached audio regenerate.
- The slim stacks generate their worker tokens on each start, so they need only the first two lines.
- The full stacks also use a default PostgreSQL password (`openreader`). PostgreSQL is not published outside the Compose network, but change it in the file if that matters to you.
- Then [create the first administrator](../configure/admin-panel#create-the-first-administrator).

Every variable is in [Environment Variables](../reference/environment-variables).

## Ports

| Port | Service | Needs to be reachable by browsers |
| --- | --- | --- |
| `3003` | OpenReader | Yes |
| `8081` | Compute worker (playback audio) | Yes |
| `8333` | SeaweedFS S3 | No; browsers go through OpenReader |
| `8880` | Kokoro-FastAPI | No |

In the full stacks, the worker shares the OpenReader container's network, so they reach each other on `127.0.0.1`. PostgreSQL and NATS stay inside the Compose network.

## Open it from other devices

Set both addresses to your Docker host's LAN IP, in `.env` or on the command line:

```bash
BASE_URL=http://192.168.0.XXX:3003 \
COMPUTE_WORKER_PUBLIC_URL=http://192.168.0.XXX:8081 \
docker compose -f examples/docker/compose.yml up -d
```

Allow inbound TCP `3003` and `8081`. Behind HTTPS, both addresses must be HTTPS, or browsers block the audio.

To let browsers reach the full stack's SeaweedFS directly, see [how browsers reach files](../configure/object-blob-storage#how-browsers-reach-files).

## Update

Pull and recreate the same Compose project. Migrations run on start.

```bash
docker compose -f examples/docker/compose.yml pull
docker compose -f examples/docker/compose.yml up -d
```

Use the file you started with, and keep the same `.env`. For the local builds, run `up -d --build` instead of `pull`. Never use `docker compose down -v`: `-v` deletes your data volumes.

Upgrading a v4 instance? Follow [Upgrade from v4](./upgrade-from-v4) first.

### Full stacks from 5.3.0 or earlier

Those full stacks ran SeaweedFS 4.18; newer ones run 4.48, which keeps its encryption key differently. Before you pull, while the old stack is still running, copy the existing key into `examples/docker/.env`, or the update leaves your documents and audio unreadable:

```bash
echo "WEED_S3_SSE_KEK=$(docker compose -f examples/docker/compose.full.yml exec -T seaweedfs wget -qO- http://127.0.0.1:8888/etc/s3/sse_kek)" >> examples/docker/.env
```

Check that the line in `.env` holds a 64-character value, then update as above. Keep it in `.env` for good, like `AUTH_SECRET`. If the value is empty, the stack never stored a file; delete the line.

New installs need nothing: SeaweedFS creates its key in the `seaweedfs-data` volume.

#### Already updated without the key?

Your files are intact, but documents and audio fail to load. Do not go back to 4.18: the update re-encrypted the stored key, and 4.18 cannot read it. Instead, with the stack running, recover the original key:

```bash
F="docker compose -f examples/docker/compose.full.yml"
WRAPPED=$($F exec -T seaweedfs wget -qO- http://127.0.0.1:8888/etc/s3/sse_kek)
PASSPHRASE=$($F exec -T seaweedfs cat /data/.mini_kek_passphrase)
KEK=$($F exec -T openreader node --input-type=module -e "import { unwrapWeedFilerKek } from '/opt/openreader/bootstrap/src/embedded-seaweedfs.mjs'; console.log(unwrapWeedFilerKek(process.argv[1], process.argv[2]))" "$WRAPPED" "$PASSPHRASE")
echo "WEED_S3_SSE_KEK=$KEK" >> examples/docker/.env
$F up -d
```

Check that the line holds a 64-character value before running the last command. Use `compose.local-full.yml` in the first line if you started from that file.
