---
title: Upgrade from v4
description: A step-by-step checklist for upgrading a v4.4 OpenReader instance to v5.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Follow this page top to bottom. It covers a single-container `docker run` install and the Docker
Compose stacks. If you are starting fresh, use the [Docker Quick Start](../docker-quick-start) instead.

:::danger There is no downgrade without a backup
The first v5 start applies database migrations that **cannot be reversed**, and permanently deletes
data v5 does not use (see [What is deleted](#what-is-deleted)). Once it has run, going back to v4
means restoring the backup from step 1. Do not skip it.
:::

## What changes

| | v4 | v5 |
| --- | --- | --- |
| Playback audio | Served by the app on port `3003` | Served by the compute worker on port **`8081`**, which browsers must be able to reach |
| Admin access | `ADMIN_EMAILS` | Granted in **Settings → Admin → Users**. `ADMIN_EMAILS` is ignored; existing admins keep their access |
| Off-localhost setups | Only `BASE_URL` | Also set **`COMPUTE_WORKER_PUBLIC_URL`** to the address browsers use for port `8081` |
| Secrets | `AUTH_SECRET` | `AUTH_SECRET` only, in a single container. Worker, broker, and playback secrets are generated or derived. External workers still need explicit shared values |
| Audiobooks | Stored in v4 format | Old audiobooks are deleted. Regenerate them from the reader |
| TTS audio cache | v4 cache | Deleted and rebuilt as you listen |

Your users, documents, reading progress, folders, preferences, and shared providers are kept.

## 1. Back up

Stop the container, then copy your data somewhere safe.

<Tabs groupId="upgrade-from-v4-install">
<TabItem value="docker-run" label="docker run" default>

```bash
docker stop openreader
docker run --rm -v openreader_docstore:/data -v "$PWD":/backup alpine \
  tar czf /backup/openreader-docstore-backup.tar.gz -C /data .
```

Use your own volume name if it is not `openreader_docstore`.

</TabItem>
<TabItem value="compose" label="Docker Compose">

```bash
docker compose -f examples/docker/compose.yml stop
docker volume ls
```

Back up each OpenReader volume listed with the same `docker run --rm -v <volume>:/data ... tar` pattern.
With the full stack, also dump PostgreSQL (`pg_dump`). Never run `docker compose down -v`: `-v`
deletes the volumes you are upgrading.

</TabItem>
</Tabs>

If you use an external database or S3 bucket, back those up with your provider's tools.

## 2. Export audiobooks you want to keep

v5 deletes v4 audiobooks. Before upgrading, open each audiobook you want to keep in v4 and download
it. You can regenerate audiobooks in v5, but generation costs time and TTS usage.

## 3. Update your configuration

<Tabs groupId="upgrade-from-v4-install">
<TabItem value="docker-run" label="docker run" default>

Replace your old command with this one. Keep the same volume, `BASE_URL`, and `AUTH_SECRET`:

```bash
docker rm openreader   # removes the old container only; the volume is kept
docker run --name openreader \
  --restart unless-stopped \
  -p 3003:3003 \
  -p 8081:8081 \
  -v openreader_docstore:/app/docstore \
  -e BASE_URL=http://localhost:3003 \
  -e AUTH_SECRET=<the-same-value-you-used-in-v4> \
  ghcr.io/richardr1126/openreader:latest
```

- Add **`-p 8081:8081`**. Without it the app loads but audio never plays.
- Keep `AUTH_SECRET` identical. It also decrypts your saved provider keys.
- Off localhost, add `-e COMPUTE_WORKER_PUBLIC_URL=http://<your-host>:8081` (or your HTTPS worker URL).
- Keep any `API_BASE` / `API_KEY` lines you had. They only seed a shared provider on first boot.
- Remove `-e ADMIN_EMAILS=...`. It does nothing in v5.

</TabItem>
<TabItem value="compose" label="Docker Compose">

Pull the latest example files, keep your `.env` values for `AUTH_SECRET` and `BASE_URL`, and remove
`ADMIN_EMAILS`. If browsers do not reach the host as `localhost`, set the worker address:

```dotenv
COMPUTE_WORKER_PUBLIC_URL=http://192.168.0.XXX:8081
```

Replace `192.168.0.XXX` with your Docker host's address and allow inbound TCP ports `3003` and `8081`.

Do not set `BOOTSTRAP_ADMIN_EMAIL` or `BOOTSTRAP_ADMIN_PASSWORD` for an upgrade; your existing admins
are preserved.

</TabItem>
</Tabs>

If the page is served over HTTPS, the worker address must be HTTPS too, or the browser blocks audio
as mixed content.

## 4. Start v5

<Tabs groupId="upgrade-from-v4-install">
<TabItem value="docker-run" label="docker run" default>

If you ran the command in step 3 it is already starting. Follow the logs:

```bash
docker logs -f openreader
```

Pull the newest image first with `docker pull ghcr.io/richardr1126/openreader:latest`.

</TabItem>
<TabItem value="compose" label="Docker Compose">

```bash
docker compose -f examples/docker/compose.yml pull
docker compose -f examples/docker/compose.yml up -d
docker compose -f examples/docker/compose.yml logs -f openreader
```

Use `compose.full.yml` for the full stack.

</TabItem>
</Tabs>

On the first start the logs print an **Upgrading from OpenReader v4** notice, then run the
migrations. If configuration is wrong, the container stops and lists every problem at once with the
fix for each. Fix them all, then start it again.

## 5. Verify

1. Sign in at your `BASE_URL`. Your library and progress should be there.
2. Open **Settings → Admin → System**. Every row should read **OK**. Each **Check** or **Fix** row
   says what is wrong and how to correct it. The most common ones:
   - *Address you opened* differs from `BASE_URL`: use the address in `BASE_URL`, or add the other one to `AUTH_TRUSTED_ORIGINS`.
   - *Playback audio URL (this browser)* fails: publish port `8081` and set `COMPUTE_WORKER_PUBLIC_URL`.
3. Open a document and press play. Audio should start after a short preparation.

## What is deleted

The first v5 start removes:

- v4 audiobooks (`audiobooks_v1/` in storage and the old audiobook tables).
- The v4 TTS audio cache (`tts_segments_v1/`, `tts_segments_v2/`).

To skip the storage purge, set `RUN_V4_DECOMMISSION=false`. Database migrations still run. See
[Migrations](../configure/migrations) for the full history.

## If something goes wrong

- **Container exits immediately:** read the logs; the message lists what to fix.
- **App loads but audio does not play:** port `8081` is not published, or `COMPUTE_WORKER_PUBLIC_URL` is wrong. **Settings → Admin → System** shows which.
- **Cannot sign in as an admin:** the account is unchanged in v5. Confirm you kept the same `AUTH_SECRET` and database volume.
- **Want to go back to v4:** stop v5, restore the backup from step 1, and start the v4 image.
