---
title: Local Development
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Prerequisites

<details>
<summary><strong>Node.js + pnpm (required)</strong></summary>

<Tabs groupId="local-dev-node-pnpm-os">
<TabItem value="macos" label="macOS" default>

```bash
brew install nvm pnpm
mkdir -p ~/.nvm
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "$(brew --prefix nvm)/nvm.sh" ] && . "$(brew --prefix nvm)/nvm.sh"' >> ~/.zshrc
source ~/.zshrc
nvm install --lts
nvm use --lts
node -v
pnpm -v
```

</TabItem>
<TabItem value="linux" label="Linux">

```bash
# Debian/Ubuntu example
sudo apt update
sudo apt install -y curl
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install --lts
nvm use --lts
corepack enable
corepack prepare pnpm@latest --activate
node -v
pnpm -v
```

</TabItem>
</Tabs>

</details>

<details>
<summary><strong>SeaweedFS <code>weed</code> binary (required unless using external S3)</strong></summary>

<Tabs groupId="local-dev-seaweed-os">
<TabItem value="macos" label="macOS" default>

```bash
brew install seaweedfs
weed version
```

:::warning SeaweedFS Compatibility Note (April 16, 2026)
If you see intermittent S3 `InternalError` upload failures with embedded storage, use SeaweedFS `4.18`.
OpenReader currently pins `4.18` in CI and Docker builds while `4.19` compatibility is investigated.
:::

</TabItem>
<TabItem value="linux" label="Linux">

```bash
# Linux amd64 example (pin 4.18)
mkdir -p "$HOME/.local/bin"
curl -fsSL -o /tmp/seaweedfs.tar.gz \
  https://github.com/seaweedfs/seaweedfs/releases/download/4.18/linux_amd64.tar.gz
tar -xzf /tmp/seaweedfs.tar.gz -C /tmp weed
install -m 0755 /tmp/weed "$HOME/.local/bin/weed"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
weed version
```

:::warning SeaweedFS Compatibility Note (April 16, 2026)
If you see intermittent S3 `InternalError` upload failures with embedded storage, use SeaweedFS `4.18`.
OpenReader currently pins `4.18` in CI and Docker builds while `4.19` compatibility is investigated.
:::

</TabItem>
</Tabs>

</details>

<details>
<summary><strong>NATS Server <code>nats-server</code> (required for embedded compute mode)</strong></summary>

If `COMPUTE_WORKER_URL` is unset, startup launches embedded compute worker + NATS, so `nats-server` must be available on host PATH.

If you always use an external worker (`COMPUTE_WORKER_URL` set), this is not required.

<Tabs groupId="local-dev-nats-os">
<TabItem value="macos" label="macOS" default>

```bash
brew install nats-server
nats-server -v
```

</TabItem>
<TabItem value="linux" label="Linux">

```bash
# Linux amd64 example
mkdir -p "$HOME/.local/bin"
curl -fsSL -o /tmp/nats-server.zip \
  https://github.com/nats-io/nats-server/releases/latest/download/nats-server-v2.12.1-linux-amd64.zip
unzip -j /tmp/nats-server.zip '*/nats-server' -d /tmp
install -m 0755 /tmp/nats-server "$HOME/.local/bin/nats-server"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
nats-server -v
```

</TabItem>
</Tabs>

</details>

<details>
<summary><strong>LibreOffice (optional, for DOCX conversion)</strong></summary>

<Tabs groupId="local-dev-libreoffice-os">
<TabItem value="macos" label="macOS" default>

```bash
brew install libreoffice
```

</TabItem>
<TabItem value="linux" label="Linux">

```bash
# Debian/Ubuntu example
sudo apt update
sudo apt install -y libreoffice
```

</TabItem>
</Tabs>

</details>

<details>
<summary><strong>Word-by-word highlighting (optional)</strong></summary>

No extra native Whisper CLI build step is required.

Word-by-word highlighting and PDF layout parsing are worker-backed in current releases.

If you need mirrors or pinned artifact locations, set `WHISPER_MODEL_BASE_URL` in `.env` (current defaults expect q4 Whisper files at that base URL).

</details>

<details>
<summary><strong>External compute worker dev stack (optional)</strong></summary>

Use this only when you intentionally run compute-worker as a separate service.
Default local flow does not need `compute/worker/.env`; embedded worker startup reads root `.env`.
Full worker deployment details are in [Compute Worker (NATS JetStream)](./compute-worker).

Start only NATS + compute-worker via compose watch:

```bash
docker compose --env-file compute/worker/.env -f compute/worker/docker-compose.yml up --watch
# or: pnpm compute:dev:watch
```

`compute/worker/.env.example` contains a starter config for standalone worker service deployments.

Run the main app separately on the host:

```bash
pnpm dev
```

For app -> external worker routing, set in root `.env`:

```env
COMPUTE_WORKER_URL=http://localhost:8081
COMPUTE_WORKER_TOKEN=<same-token-used-by-worker>
```

Ownership in external worker mode:
- root `.env`: app routing/auth (`COMPUTE_WORKER_URL`, `COMPUTE_WORKER_TOKEN`) plus optional shared timeout/stale/retry overrides such as `COMPUTE_PDF_JOB_ATTEMPTS`
- `compute/worker/.env*` (or worker platform env): worker runtime variables (`NATS_*`, `S3_*`, model base URLs, worker tuning)

For embedded worker startup (`COMPUTE_WORKER_URL` unset), worker tuning values such as `COMPUTE_PDF_JOB_ATTEMPTS` must be set in the root `.env` because `compute/worker/.env*` is ignored in that mode.

Worker mode requires worker-reachable shared object storage (S3-compatible endpoint).
For external worker mode, object storage must be shared/reachable by both app and worker services.

</details>

## Steps

### Required flow

1. Clone the repository.

```bash
git clone https://github.com/richardr1126/openreader.git
cd openreader
```

2. Install dependencies.

```bash
pnpm i
```

3. Configure the environment.

```bash
cp .env.example .env
```

Then edit `.env`.

Default embedded worker flow (no external worker URL):

```env
# Leave COMPUTE_WORKER_URL unset.
# Entry point auto-starts embedded worker+NATS when available.
```

External worker flow:

```env
COMPUTE_WORKER_URL=http://localhost:8081
COMPUTE_WORKER_TOKEN=<same-token-used-by-worker>
```

Use the same ownership split:
- root `.env`: app routing/auth (`COMPUTE_WORKER_URL`, `COMPUTE_WORKER_TOKEN`) plus optional shared timeout/stale overrides
- `compute/worker/.env*` (or worker platform env): worker runtime variables (`NATS_*`, `S3_*`, model base URLs, worker tuning)

Use one of these `.env` mode templates:

<Tabs groupId="local-env-modes">
  <TabItem value="auth-enabled" label="Auth Enabled" default>

```env
API_BASE=http://host.docker.internal:8880/v1
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
# Optional when you need multiple local origins:
# AUTH_TRUSTED_ORIGINS=http://localhost:3003,http://127.0.0.1:3003
```

  </TabItem>
  <TabItem value="auth-with-admin" label="Auth + Admin Panel">

```env
# API_BASE and optional API_KEY are seeded into the admin "default-openai" shared provider
# on first boot, then no longer read. Manage them in Settings → Admin afterwards.
API_BASE=http://host.docker.internal:8880/v1
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
# Comma-separated emails to auto-promote to admin on signin.
ADMIN_EMAILS=you@example.com
```

  </TabItem>
  <TabItem value="external-s3" label="External S3">

```env
API_BASE=http://host.docker.internal:8880/v1
USE_EMBEDDED_WEED_MINI=false
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
# Optional for non-AWS providers:
# S3_ENDPOINT=https://your-s3-compatible-endpoint
# S3_FORCE_PATH_STYLE=true
```

  </TabItem>
  <TabItem value="worker-mode" label="External Worker Service">

```env
API_BASE=http://host.docker.internal:8880/v1
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
COMPUTE_WORKER_URL=http://localhost:8081
COMPUTE_WORKER_TOKEN=<same-token-used-by-worker>
USE_EMBEDDED_WEED_MINI=false
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
# Optional for non-AWS providers:
# S3_ENDPOINT=https://your-s3-compatible-endpoint
# S3_FORCE_PATH_STYLE=true
```

  </TabItem>
</Tabs>

:::note Env vars vs. admin panel
On first boot, `API_KEY` / `API_BASE` can bootstrap `default-openai`, and `RUNTIME_SEED_JSON` / `RUNTIME_SEED_JSON_PATH` can seed runtime config + providers. After that, the admin UI is authoritative and editing bootstrap env vars no longer changes app behavior. See [Admin Panel](../configure/admin-panel).
:::

:::note User BYOK restriction default
If you want each user to enter personal provider credentials, set `restrictUserApiKeys=false` (from **Settings → Admin**, or by seeding `runtimeConfig.restrictUserApiKeys=false` in runtime seed JSON).
:::

:::info
For all environment variables, see [Environment Variables](../reference/environment-variables).
:::

See [Auth](../configure/auth) for app/auth behavior.
See [Admin Panel](../configure/admin-panel) for the shared-provider and feature-flag management UI.
Storage configuration details are in [Object / Blob Storage](../configure/object-blob-storage).
Refer to [Database](../configure/database) for database modes.
Learn about migration behavior and commands in [Migrations](../configure/migrations).

:::info Scheduled maintenance tasks
Local and self-hosted Node.js deployments start the scheduled-task loop in-process and check for due work once per minute. No `CRON_SECRET` is required unless you intentionally invoke the cron HTTP route yourself. Manage task intervals and inspect failures from **Settings → Admin → Scheduled tasks**.
:::

4. Start the app.

<Tabs groupId="local-run-mode">
  <TabItem value="dev" label="Dev (recommended)" default>

```bash
pnpm dev
```

If you use embedded worker startup (no `COMPUTE_WORKER_URL`) and the host is missing `nats-server`,
install `nats-server` locally or switch to external worker mode.

  </TabItem>
  <TabItem value="prod" label="Build + Start">

```bash
pnpm build
pnpm start
```

  </TabItem>
</Tabs>

:::warning API Base Reachability
`API_BASE` must be reachable from the Next.js server process, not just your browser.
:::

Visit [http://localhost:3003](http://localhost:3003).

### Optional workflows

Run manual DB migrations only for troubleshooting or explicit migration workflows:

- Migrations run automatically on startup through the shared entrypoint for both `pnpm dev` and `pnpm start`.

```bash
pnpm migrate
```

:::info
If `POSTGRES_URL` is set, migrations target Postgres; otherwise local SQLite is used. To disable automatic startup migrations, set `RUN_DRIZZLE_MIGRATIONS=false` and/or `RUN_FS_MIGRATIONS=false`. You can run storage migration manually with `pnpm migrate-fs`.
:::
