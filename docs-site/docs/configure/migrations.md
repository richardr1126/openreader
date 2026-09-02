---
title: Migrations
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

This page covers migration behavior for both database schema and storage data in OpenReader.

## Runtime ownership

- `@openreader/database` owns database clients, schemas, SQL migration files, and programmatic
  migration execution for SQLite and PostgreSQL.
- `@openreader/bootstrap` owns startup orchestration, v4 legacy storage decommission, and optional embedded
  SeaweedFS, NATS, and compute-worker processes.
- The Next.js app imports `@openreader/database` directly, but does not orchestrate migrations or
  child processes.

Docker deploys bootstrap as an isolated runtime bundle under `/opt/openreader/bootstrap`; it does
not merge migration dependencies into the standalone Next.js app under `/app`.

## Startup migration behavior

By default, the shared entrypoint runs migrations automatically before app startup in:

- Docker container startup
- `pnpm dev`
- `pnpm start`

Startup migration phases:

- DB schema migrations (`pnpm migrate`)
- v4 legacy storage decommission (`pnpm migrate-decommission`) for deleting retired object prefixes

:::info
In most setups, you do not need to run migration commands manually because startup handles this automatically.
:::

### Schema history

Migrations are applied in order for both SQLite and Postgres. A v4.4 database upgrading to v5
keeps its users, documents, progress, folders, preferences, providers, settings, and scheduled-task
state while applying the later v5 migrations.

| Migration | Dialects | What it does |
| --- | --- | --- |
| `0000` | SQLite + Postgres | Creates the baseline document, user-preference, progress, auth, preview, and legacy audiobook schema. |
| `0001`–`0003` | SQLite + Postgres | Introduces and evolves the pre-v5 SQL TTS segment cache. |
| `0004` | SQLite + Postgres | Creates encrypted shared providers and admin settings, and adds user admin status. |
| `0005`–`0009` | SQLite + Postgres | Adds document settings and transitional PDF parsing/job-event state, then removes superseded PDF state. |
| `0010` | SQLite + Postgres | Adds user-data cleanup cascades. |
| `0011` | SQLite + Postgres | Adds scheduled maintenance tasks and document blob leases. |
| `0012` | SQLite + Postgres | Adds folders, onboarding/privacy state, and recently-opened document state. |
| `0013`–`0014` | SQLite + Postgres | Adds transitional SQL playback-session state used during v5 development. |
| `0015` | SQLite + Postgres | Removes the retired SQL TTS cache, transitional playback sessions, legacy audiobook tables, and their obsolete cleanup task. v5 playback artifacts live in object storage. |
| `0016` | SQLite + Postgres | Adds explicit account identity issuers, normalizes existing credential/GitHub identities, and adds identity indexes. |

To skip automatic startup migrations:

- Set `RUN_DRIZZLE_MIGRATIONS=false`
- Set `RUN_V4_DECOMMISSION=false`

:::warning
If you disable startup migrations, ensure your deployment process runs migrations before serving traffic.
:::

## Apply migrations

In most cases, you do not need manual migration commands because startup runs migrations automatically.

### Docker and Docker Compose

The published app image runs the shared bootstrap entrypoint. Pull and recreate the container or
Compose services with the same database/storage volumes and stable secrets; the entrypoint applies
pending DB migrations and then runs the v4 storage decommission before starting the app. Do not use
`docker compose down -v` during an upgrade.

The decommission is idempotent and deletes only these retired object roots beneath `S3_PREFIX`:

- `tts_segments_v1/`
- `tts_segments_v2/`
- `audiobooks_v1/`

No manual `pnpm` command or migration-only container is needed for the supported Docker paths. See
[Docker Quick Start](../docker-quick-start#3-upgrade-from-v44-to-v5) or
[Docker Compose](../deploy/docker-compose#upgrade-from-v44-to-v5).

### Native source and custom/serverless deployments

`pnpm migrate` applies migrations for one database target:

- Postgres when `POSTGRES_URL` is set
- SQLite when `POSTGRES_URL` is unset

```bash
# Run pending migrations for one target:
# - Postgres if POSTGRES_URL is set
# - SQLite if POSTGRES_URL is unset
pnpm migrate

# Purge retired v4 object prefixes: tts_segments_v1, tts_segments_v2, audiobooks_v1
pnpm migrate-decommission
```

Use the manual commands when deploying the standalone Next.js app without the bootstrap entrypoint,
including Vercel. `pnpm migrate-decommission` requires the same S3 endpoint, bucket, region,
credentials, path-style setting, and prefix as the deployment. Pause traffic and back up the
database and object store before a v4.4→v5 production upgrade.

Startup logs include `Running database migrations...` and
`Running v4 legacy storage decommission...`; confirm both phases complete before restoring traffic.

`pnpm migrate` uses the programmatic Drizzle migrator from `@openreader/database`. Drizzle Kit is
not a production or startup dependency; it is used only to generate new migration files.

## Generate migrations

`pnpm generate` is a two-phase script for contributors and schema changes:

1. **Better Auth schema generation** — runs the Better Auth CLI twice (once for SQLite, once for Postgres) to produce auto-generated Drizzle schema files for auth tables (`user`, `session`, `account`, `verification`).
2. **Drizzle migration generation** — runs `drizzle-kit generate` for both configs in `packages/database`, producing SQL migration files from all schema files (app + auth).

:::note
Most users do not need to run `pnpm generate`. Use it when contributing or when you have changed Drizzle schema files and need new migration files.
:::

### Schema ownership

Auth tables are owned by Better Auth. Their Drizzle schema definitions are auto-generated and should **not** be hand-edited:

- `packages/database/src/schema_auth_sqlite.ts`
- `packages/database/src/schema_auth_postgres.ts`

App-specific tables are manually maintained in the standard Drizzle schema files:

- `packages/database/src/schema_sqlite.ts`
- `packages/database/src/schema_postgres.ts`

Both sets of schema files are included in the Drizzle generation configs. Runtime migration
execution is owned by `@openreader/database`.

When app schema changes (for example `tts_segment_entries` and `tts_segment_variants`), keep these in sync:

- `packages/database/src/schema_sqlite.ts`
- `packages/database/src/schema_postgres.ts`
- `packages/database/migrations/sqlite/*.sql` + `packages/database/migrations/sqlite/meta/_journal.json`
- `packages/database/migrations/postgres/*.sql` + `packages/database/migrations/postgres/meta/_journal.json`

<Tabs groupId="generate-migration-commands">
  <TabItem value="project-script" label="Project Script" default>

```bash
# Full pipeline: Better Auth CLI + Drizzle generate (both dialects)
pnpm generate
```

  </TabItem>
  <TabItem value="drizzle-direct" label="Manual Drizzle Cmd">

```bash
# Generate SQLite migrations only (skips Better Auth CLI)
pnpm exec drizzle-kit generate --config packages/database/drizzle.config.sqlite.ts

# Generate Postgres migrations only (skips Better Auth CLI)
pnpm exec drizzle-kit generate --config packages/database/drizzle.config.pg.ts
```

:::warning
Running `drizzle-kit generate` directly skips the Better Auth CLI step. If auth schema has changed upstream (e.g. after a Better Auth version bump), run `pnpm generate` instead to regenerate the auth schema files first.
:::

  </TabItem>
</Tabs>

## Related docs

- [Database](./database)
- [Object / Blob Storage](./object-blob-storage)
- [Migration Environment Variables](../reference/environment-variables#migration-controls)
