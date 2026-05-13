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
<summary><strong>whisper.cpp (optional, for word-by-word highlighting)</strong></summary>

Install build dependencies:

<Tabs groupId="local-dev-whisper-deps-os">
<TabItem value="macos" label="macOS" default>

```bash
brew install cmake
```

</TabItem>
<TabItem value="linux" label="Linux">

```bash
# Debian/Ubuntu example
sudo apt update
sudo apt install -y git build-essential cmake
```

</TabItem>
</Tabs>

Build whisper.cpp:

```bash
# clone and build whisper.cpp (no model download needed – OpenReader handles that)
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release

# point OpenReader to the compiled whisper-cli binary
echo WHISPER_CPP_BIN="$(pwd)/build/bin/whisper-cli"
```

If you are not on Debian/Ubuntu, install equivalent packages with your distro package manager:

- Fedora/RHEL: use `dnf` (`gcc gcc-c++ make cmake curl git tar xz`)
- Arch: use `pacman` (`base-devel cmake curl git tar xz`)

:::tip
Set `WHISPER_CPP_BIN` in your `.env` to enable word-by-word highlighting.
:::

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

Use one of these `.env` mode templates:

<Tabs groupId="local-env-modes">
  <TabItem value="no-auth" label="No Auth (simple)" default>

```env
API_BASE=http://host.docker.internal:8880/v1
API_KEY=none
# Leave BASE_URL and AUTH_SECRET unset to keep auth disabled.
# (Admin panel is unavailable without auth.)
# API_BASE/API_KEY seed a shared default provider if you want shared mode.
```

  </TabItem>
  <TabItem value="auth-enabled" label="Auth Enabled">

```env
API_BASE=http://host.docker.internal:8880/v1
API_KEY=none
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
# Optional when you need multiple local origins:
# AUTH_TRUSTED_ORIGINS=http://localhost:3003,http://127.0.0.1:3003
```

  </TabItem>
  <TabItem value="auth-with-admin" label="Auth + Admin Panel">

```env
# API_BASE / API_KEY are seeded into the admin "default-openai" shared provider
# on first boot, then no longer read. Manage them in Settings → Admin afterwards.
API_BASE=http://host.docker.internal:8880/v1
API_KEY=none
BASE_URL=http://localhost:3003
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
# Comma-separated emails to auto-promote to admin on signin.
ADMIN_EMAILS=you@example.com
```

  </TabItem>
  <TabItem value="external-s3" label="External S3">

```env
API_BASE=http://host.docker.internal:8880/v1
API_KEY=none
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
On first boot, `API_KEY` / `API_BASE` and any `NEXT_PUBLIC_*` flags you've set get auto-seeded into the admin-managed runtime config (DB-backed, keys encrypted at rest). After that, the admin UI is authoritative and editing those env vars no longer changes app behavior. See [Admin Panel](../configure/admin-panel).
:::

:::note User BYOK restriction default
If you want each user to enter personal provider credentials, set `restrictUserApiKeys=false` (from **Settings → Admin** when auth/admin is enabled, or via legacy first-boot seed `NEXT_PUBLIC_RESTRICT_USER_API_KEYS=false` for no-admin bootstrap flows).
:::

:::info
For all environment variables, see [Environment Variables](../reference/environment-variables).
:::

See [Auth](../configure/auth) for app/auth behavior.
See [Admin Panel](../configure/admin-panel) for the shared-provider and feature-flag management UI.
Storage configuration details are in [Object / Blob Storage](../configure/object-blob-storage).
Refer to [Database](../configure/database) for database modes.
Learn about migration behavior and commands in [Migrations](../configure/migrations).

4. Start the app.

<Tabs groupId="local-run-mode">
  <TabItem value="dev" label="Dev (recommended)" default>

```bash
pnpm dev
```

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
