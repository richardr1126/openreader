---
title: Local Development
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Prerequisites

- Node.js (recommended with [nvm](https://github.com/nvm-sh/nvm))
- `pnpm` (recommended) or `npm`

```bash
npm install -g pnpm
```

- A reachable TTS API server
- [SeaweedFS](https://github.com/seaweedfs/seaweedfs) `weed` binary (required unless using external S3 storage)

<Tabs groupId="seaweedfs-install">
  <TabItem value="macos" label="macOS" default>

```bash
brew install seaweedfs
```

  </TabItem>
  <TabItem value="linux" label="Linux">

Install the `weed` binary from the [SeaweedFS releases](https://github.com/seaweedfs/seaweedfs/releases) and ensure it is available on `PATH`.

  </TabItem>
</Tabs>

Optional, depending on features:

- [libreoffice](https://www.libreoffice.org) (required for DOCX conversion)

```bash
brew install libreoffice
```

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (optional, for word-by-word highlighting)

```bash
# clone and build whisper.cpp (no model download needed – OpenReader handles that)
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release

# point OpenReader to the compiled whisper-cli binary
echo WHISPER_CPP_BIN="$(pwd)/build/bin/whisper-cli"
```

:::tip
Set `WHISPER_CPP_BIN` in your `.env` to enable word-by-word highlighting.
:::

## Steps

1. Clone the repository.

```bash
git clone https://github.com/richardr1126/OpenReader-WebUI.git
cd OpenReader-WebUI
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

- No auth mode: leave `BASE_URL` or `AUTH_SECRET` unset.
- Auth enabled mode: set both `BASE_URL` (typically `http://localhost:3003`) and `AUTH_SECRET` (generate with `openssl rand -hex 32`).

Optional:

- `AUTH_TRUSTED_ORIGINS=http://localhost:3003,http://192.168.0.116:3003`
- Stable S3 credentials via `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`
- External S3 storage by setting `USE_EMBEDDED_WEED_MINI=false` and related S3 vars

:::info
For all environment variables, see [Environment Variables](../reference/environment-variables).
:::

See [Auth](../configure/auth) for app/auth behavior.
Storage configuration details are in [Object / Blob Storage](../configure/object-blob-storage).
Refer to [Database](../configure/database) for database modes.
Learn about migration behavior and commands in [Migrations](../configure/migrations).

4. Run DB migrations.

- Migrations run automatically on startup through the shared entrypoint for both `pnpm dev` and `pnpm start`.
- You only need manual migration commands for one-off troubleshooting or explicit migration workflows:

```bash
pnpm migrate
```

:::info
If `POSTGRES_URL` is set, migrations target Postgres; otherwise local SQLite is used. To disable automatic startup migrations, set `RUN_DRIZZLE_MIGRATIONS=false` and/or `RUN_FS_MIGRATIONS=false`. You can run storage migration manually with `pnpm migrate-fs`.
:::

5. Start the app.

<Tabs groupId="local-run-mode">
  <TabItem value="dev" label="Dev" default>

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
