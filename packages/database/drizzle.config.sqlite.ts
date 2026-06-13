import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

export default {
  schema: ['./packages/database/src/schema_sqlite.ts', './packages/database/src/schema_auth_sqlite.ts'],
  out: './packages/database/migrations/sqlite',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'docstore/sqlite3.db',
  },
} satisfies Config;
