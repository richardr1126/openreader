---
title: Migrations
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

This page covers migration behavior for both database schema and storage data in OpenReader.

## Startup migration behavior

By default, the shared entrypoint runs migrations automatically before app startup in:

- Docker container startup
- `pnpm dev`
- `pnpm start`

Startup migration phases:

- DB schema migrations (`pnpm migrate`)
- Storage/data migration (`pnpm migrate-fs`) for legacy filesystem content into S3 + DB rows

:::info
In most setups, you do not need to run migration commands manually because startup handles this automatically.
:::

To skip automatic startup migrations:

- Set `RUN_DRIZZLE_MIGRATIONS=false`
- Set `RUN_FS_MIGRATIONS=false`

:::warning
If you disable startup migrations, ensure your deployment process runs migrations before serving traffic.
:::

## Apply migrations

In most cases, you do not need manual migration commands because startup runs migrations automatically.

`pnpm migrate` applies migrations for one database target:

- Postgres when `POSTGRES_URL` is set
- SQLite when `POSTGRES_URL` is unset

You can always override the target explicitly with `--config`.

<Tabs groupId="apply-migration-commands">
  <TabItem value="project-scripts" label="Project Scripts" default>

```bash
# Run pending migrations for one target:
# - Postgres if POSTGRES_URL is set
# - SQLite if POSTGRES_URL is unset
pnpm migrate

# Run storage migration (filesystem -> S3 + DB)
pnpm migrate-fs

# Dry-run storage migration without uploading/deleting
pnpm migrate-fs:dry-run
```

  </TabItem>
  <TabItem value="drizzle-direct" label="Manual Drizzle Cmd">

```bash
# Migrate SQLite
pnpm exec drizzle-kit migrate --config drizzle.config.sqlite.ts

# Migrate Postgres
pnpm exec drizzle-kit migrate --config drizzle.config.pg.ts
```

  </TabItem>
</Tabs>

## Generate migrations

`pnpm generate` is a two-phase script for contributors and schema changes:

1. **Better Auth schema generation** — runs the Better Auth CLI twice (once for SQLite, once for Postgres) to produce auto-generated Drizzle schema files for auth tables (`user`, `session`, `account`, `verification`).
2. **Drizzle migration generation** — runs `drizzle-kit generate` for both `drizzle.config.sqlite.ts` and `drizzle.config.pg.ts`, producing SQL migration files from all schema files (app + auth).

:::note
Most users do not need to run `pnpm generate`. Use it when contributing or when you have changed Drizzle schema files and need new migration files.
:::

### Schema ownership

Auth tables are owned by Better Auth. Their Drizzle schema definitions are auto-generated and should **not** be hand-edited:

- `src/db/schema_auth_sqlite.ts`
- `src/db/schema_auth_postgres.ts`

App-specific tables are manually maintained in the standard Drizzle schema files:

- `src/db/schema_sqlite.ts`
- `src/db/schema_postgres.ts`

Both sets of schema files are included in the Drizzle configs, so `drizzle-kit generate` and `drizzle-kit migrate` handle all tables together.

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
pnpm exec drizzle-kit generate --config drizzle.config.sqlite.ts

# Generate Postgres migrations only (skips Better Auth CLI)
pnpm exec drizzle-kit generate --config drizzle.config.pg.ts
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
