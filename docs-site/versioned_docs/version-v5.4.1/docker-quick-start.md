---
title: Docker Quick Start
description: Start OpenReader with the maintained Docker Compose example.
---

The [Docker Compose guide](./deploy/docker-compose) is the maintained Docker setup. The slim example runs OpenReader, its embedded storage and compute services, and Kokoro-FastAPI. Use the full example if you want PostgreSQL, SeaweedFS, NATS, and the worker in separate containers.

## Start a new instance

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/richardr1126/openreader.git
   cd openreader
   ```

2. Create `examples/docker/.env` with a stable `AUTH_SECRET` and a unique first-admin credential:

   ```dotenv
   AUTH_SECRET=<random-value-from-openssl-rand-base64-32>
   BOOTSTRAP_ADMIN_EMAIL=owner@example.com
   BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
   ```

   Keep this file private. Generate the secret with `openssl rand -base64 32`. Compose reads the `.env` next to the Compose file, not one in the repository root.

3. Start the stack:

   ```bash
   docker compose -f examples/docker/compose.yml up -d
   ```

4. Open `http://localhost:3003`, sign in with that email and password, and change the password in **Settings → Account**. The **Admin** tab then appears. See [Create the first administrator](./configure/admin-panel#create-the-first-administrator) for details.

5. Open **Settings → Admin → Maintenance** to confirm the worker, storage and providers are healthy.

The stack starts with a Kokoro voice provider already set up. For the other stack variants, LAN access and production secrets, see the [Docker Compose guide](./deploy/docker-compose). Upgrading a v4 instance? Follow [Upgrade from v4](./deploy/upgrade-from-v4).
