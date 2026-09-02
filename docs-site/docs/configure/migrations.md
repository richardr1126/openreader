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

Migrations are applied in order. All of the following ship in v3.0.0; an instance upgrading from v2.2.0 applies `0001`–`0004` in a single startup pass.

| Migration | Dialects | What it does |
| --- | --- | --- |
| `0001_tts_segments` | SQLite + Postgres | Creates the original single-table `tts_segments` used by server-side TTS segment caching. |
| `0002_add_segment_key_to_tts_segments` | SQLite + Postgres | Adds the `segment_key` column to `tts_segments` for stable locator-independent segment identity. |
| `0003_tts_segments_v2_split` | SQLite + Postgres | Replaces `tts_segments` with a normalized two-table model: `tts_segment_entries` (one row per document segment + locator identity) and `tts_segment_variants` (one row per settings combination, holding the cached audio key, status, and alignment). Drops the original `tts_segments` table — no released build (v2.2.0 or earlier) ever populated it, so there is no production data to migrate. |
| `0004_admin_panel` | SQLite + Postgres | Creates `admin_providers` (encrypted shared TTS provider rows) and `admin_settings` (runtime site-feature config), and adds the `is_admin` column to the `user` table. Backs the [Admin Panel](./admin-panel). |

To skip automatic startup migrations:

- Set `RUN_DRIZZLE_MIGRATIONS=false`
- Set `RUN_V4_DECOMMISSION=false`

:::warning
If you disable startup migrations, ensure your deployment process runs migrations before serving traffic.
:::

## Apply migrations

In most cases, you do not need manual migration commands because startup runs migrations automatically.

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
