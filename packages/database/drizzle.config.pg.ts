import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

let url = process.env.POSTGRES_URL;
if (!url) {
  console.warn('[drizzle.config.pg.ts] POSTGRES_URL is not set; using a placeholder URL.');
  url = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
}

export default {
  schema: ['./packages/database/src/schema_postgres.ts', './packages/database/src/schema_auth_postgres.ts'],
  out: './packages/database/migrations/postgres',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
} satisfies Config;
