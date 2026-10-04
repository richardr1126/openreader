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

:::tip Docker Compose
To run OpenReader and Kokoro-FastAPI with Docker Compose, including slim, full, and local-build
options, see [Docker Compose](./docker-compose).
:::

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

3. Create your `.env` file.

```bash
cp .env.example .env
openssl rand -base64 32
```

Open `.env` and set these two values. Paste the command output as `AUTH_SECRET`:

```env
BASE_URL=http://localhost:3003
AUTH_SECRET=<paste-the-generated-value>
```

That is a complete configuration: the app starts its own storage, queue, and compute worker, and
the worker and playback secrets are generated or derived for you. Keep `AUTH_SECRET` stable, since it
also encrypts saved provider keys.

Then add only what applies to you. Each tab lists **what to add to the same `.env`**, so you can
combine them. If something is missing or wrong, startup lists every problem at once and exits.

<Tabs groupId="local-env-additions">
  <TabItem value="admin" label="First admin account" default>

**Use when:** you want an admin account ready on the first boot.

```env
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
```

**Then:** sign in, and change the password in **Settings → Account**. The **Admin** tab appears
after that. Remove these two lines afterward.

  </TabItem>
  <TabItem value="tts" label="Existing TTS server">

**Use when:** you already run an OpenAI-compatible speech server such as Kokoro-FastAPI.

```env
API_BASE=http://127.0.0.1:8880/v1
API_MODEL_NAME=kokoro
# API_KEY=<only-if-your-server-requires-one>
```

**Then:** these are read once on first boot to create a shared provider. Manage providers later in
**Settings → Admin → Providers**. Adding them after the first boot has no effect.

  </TabItem>
  <TabItem value="s3" label="External S3">

**Use when:** you want an S3-compatible bucket instead of the embedded SeaweedFS.

```env
USE_EMBEDDED_WEED_MINI=false
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
# Non-AWS providers only:
# S3_INTERNAL_ENDPOINT=https://your-s3-compatible-endpoint
# S3_PUBLIC_ENDPOINT=https://s3.your-domain.example
# S3_BROWSER_TRANSPORT=presigned
# S3_FORCE_PATH_STYLE=true
```

**Then:** the `weed` binary is no longer needed. See [Object / Blob Storage](../configure/object-blob-storage).

  </TabItem>
  <TabItem value="worker" label="External worker">

**Use when:** the compute worker runs as its own service. The `nats-server` binary is then not
needed on this machine.

```env
COMPUTE_WORKER_URL=http://localhost:8081
COMPUTE_WORKER_TOKEN=<same-token-used-by-worker>
COMPUTE_CREDENTIAL_BROKER_TOKEN=<same-broker-token-used-by-worker>
TTS_PLAYBACK_TOKEN_SECRET=<same-secret-used-by-worker>
# Only when browsers reach the worker at a different address:
# COMPUTE_WORKER_PUBLIC_URL=http://localhost:8081
```

**Then:** set the same three values on the worker, along with its own `NATS_*`, `S3_*`, and
`COMPUTE_CREDENTIAL_BROKER_URL` settings. `AUTH_SECRET` and database settings stay on the app only.
See [Compute Worker](./compute-worker).

  </TabItem>
</Tabs>

:::note Env vars vs. admin panel
Provider and runtime settings in `.env` seed the database on first boot (`API_*`,
`RUNTIME_SEED_JSON`, `RUNTIME_SEED_JSON_PATH`). After that the admin UI is authoritative and editing
those variables no longer changes behavior. See [Admin Panel](../configure/admin-panel). Browsers
never supply provider credentials.
:::

Related guides: [Auth](../configure/auth), [Database](../configure/database),
[Migrations](../configure/migrations), and the full
[Environment Variables](../reference/environment-variables) reference. Upgrading from v4? See
[Upgrade from v4](./upgrade-from-v4).

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

:::warning Provider reachability
Background speech generation runs in the compute worker, while optional custom voice discovery runs
in the app server. A self-hosted provider base URL must therefore be reachable from both runtimes.
For native `pnpm dev`/`pnpm start` with the embedded worker, `http://127.0.0.1:<port>/v1` is correct.
If the worker is remote, configure a URL reachable from that host as well.
:::

Visit [http://localhost:3003](http://localhost:3003). Signed in as an admin, open **Settings → Admin → Maintenance** to confirm the worker, storage, and providers are healthy.

### Optional workflows

Run manual DB migrations only for troubleshooting or explicit migration workflows:

- Migrations run automatically on startup through the shared entrypoint for both `pnpm dev` and `pnpm start`.

```bash
pnpm migrate
```

:::info
If `POSTGRES_URL` is set, migrations target Postgres; otherwise local SQLite is used. To disable automatic startup migrations, set `RUN_DRIZZLE_MIGRATIONS=false` and/or `RUN_V4_DECOMMISSION=false`. You can run the idempotent v4 legacy storage decommission manually with `pnpm migrate-decommission`. See [Upgrade from v4](./upgrade-from-v4) before a production v4.4→v5 upgrade.
:::
