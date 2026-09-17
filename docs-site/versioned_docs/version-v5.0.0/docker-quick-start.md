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

2. Create a `.env` file in the repository root with a stable `AUTH_SECRET` and a unique first-admin credential:

   ```dotenv
   AUTH_SECRET=<random-value-from-openssl-rand-base64-32>
   BOOTSTRAP_ADMIN_EMAIL=owner@example.com
   BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
   ```

   Keep this file private. Generate the secret with `openssl rand -base64 32`; do not commit the file. Compose reads an `.env` in the directory from which you run the command.

3. Start the stack:

   ```bash
   docker compose -f examples/docker/compose.yml up -d
   ```

4. Open `http://localhost:3003`, sign in with the initial credential, and change its password in **Settings → Account**. The **Admin** tab appears after that change. Setup is complete—there is no need to edit `.env` or restart. The one-time seed marker remains in the database, and the initial password no longer works. You may remove the bootstrap values from `.env` later as optional secret hygiene.

The initial email is an account identifier, **not** an email allowlist. It never promotes a later signup, and `ADMIN_EMAILS` is no longer used. If account email delivery is enabled, the first sign-in attempt sends a verification link; follow it before signing in. Other admins can be granted from **Settings → Admin → Users**.

For all stack variants, LAN access, security settings, and upgrades, use the [Docker Compose guide](./deploy/docker-compose). Do not delete volumes during an upgrade.
